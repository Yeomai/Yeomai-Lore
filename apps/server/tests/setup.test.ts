import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { SessionService } from "../src/auth/session.ts";
import { TokenService } from "../src/auth/token-service.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import {
  isLocalOrCommonLanHost,
  loreCertificateRequired,
  normalizeLorePublicUrl,
  normalizeUnifiedSiteAddress,
  validateLoreCertificate,
} from "../src/setup.ts";

describe("first-run setup", () => {
  it("creates the only administrator without an organization and locks setup", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-setup-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      APP_PUBLIC_URL: "http://localhost:3000",
      API_INTERNAL_URL: "http://localhost:4000",
      OIDC_KEY_DIR: path.join(directory, "keys"),
      LORE_RUNTIME_CONFIG_PATH: path.join(directory, "config", "local.toml"),
      LORE_STORAGE_PATH: path.join(directory, "lore"),
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await migrate(db);
      const tokens = await TokenService.create(config, db);
      app = await buildApp({
        config,
        db,
        lore: {},
        session: new SessionService(db, config),
        tokens,
        oauth: {},
        mailer: { send: async () => {} },
        logger: false,
      } as never);

      const initial = await app.inject({
        method: "GET",
        url: "/api/v1/setup",
      });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({
        required: true,
        defaults: {
          siteName: "Yeomai Lore",
          webPublicUrl: "http://localhost:3000",
          lorePublicUrl: "",
          userRegistrationEnabled: false,
          username: "admin",
          email: "admin@example.com",
          displayName: "Administrator",
        },
      });
      expect(initial.json().defaults).not.toHaveProperty("smtp");
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/auth/register",
            payload: {
              email: "early@example.com",
              username: "earlyuser",
              password: "123456",
            },
          })
        ).statusCode,
      ).toBe(409);
      const completed = await app.inject({
        method: "POST",
        url: "/api/v1/setup",
        payload: {
          siteName: "Studio Lore",
          publicAddress: "localhost:3000",
          username: "admin",
          email: "admin@example.com",
          displayName: "Studio Admin",
          password: "123456",
          confirmPassword: "123456",
          userRegistrationEnabled: false,
        },
      });
      expect(completed.statusCode).toBe(201);
      expect(completed.json()).toEqual({
        ok: true,
        restartRequired: false,
      });
      expect(completed.headers["set-cookie"]).toContain("lore_portal_session=");

      const user = await db.query<{
        username: string;
        display_name: string;
        global_role: string;
      }>(
        `SELECT username, display_name, global_role
           FROM users`,
      );
      expect(user.rows).toEqual([
        {
          username: "admin",
          display_name: "Studio Admin",
          global_role: "admin",
        },
      ]);
      const organizations = await db.query<{ count: number }>(
        "SELECT count(*) AS count FROM organizations",
      );
      expect(Number(organizations.rows[0]?.count)).toBe(0);
      const smtpSettings = await db.query<{ count: number }>(
        "SELECT count(*) AS count FROM system_settings WHERE key LIKE 'smtp_%'",
      );
      expect(Number(smtpSettings.rows[0]?.count)).toBe(0);

      const meta = await app.inject({
        method: "GET",
        url: "/api/v1/meta",
      });
      expect(meta.json()).toMatchObject({
        siteName: "Studio Lore",
        userRegistrationEnabled: false,
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/v1/setup",
          })
        ).json().required,
      ).toBe(false);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/setup",
            payload: {
              siteName: "Again",
              publicAddress: "localhost:3000",
              username: "other",
              email: "other@example.com",
              password: "123456",
              confirmPassword: "123456",
              userRegistrationEnabled: true,
            },
          })
        ).statusCode,
      ).toBe(409);

      const runtimeConfig = readFileSync(config.loreRuntimeConfigPath, "utf8");
      expect(runtimeConfig).toContain('jwt_issuer = "http://localhost:3000"');
      expect(runtimeConfig).toContain(
        'auth_url = "https://localhost:50051"',
      );
      expect(runtimeConfig).not.toContain("resource_claim");
      expect(runtimeConfig).toContain(
        `path = ${JSON.stringify(path.join(directory, "lore"))}`,
      );
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Lore setup addresses", () => {
  it("recognizes local and common LAN hosts", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "192.168.1.20",
      "10.2.3.4",
      "172.20.1.5",
      "[::1]",
      "lore.local",
    ]) {
      expect(isLocalOrCommonLanHost(host)).toBe(true);
    }
    expect(isLocalOrCommonLanHost("lore.example.com")).toBe(false);
    expect(isLocalOrCommonLanHost("8.8.8.8")).toBe(false);
    expect(loreCertificateRequired("lore://lore.example.com:41337")).toBe(true);
    expect(loreCertificateRequired("lore://192.168.1.20:41337")).toBe(false);
  });

  it("normalizes HTTPS Lore addresses to lores URLs", () => {
    expect(normalizeLorePublicUrl("https://lore.example.com")).toBe(
      "grpcs://lore.example.com:443",
    );
    expect(normalizeLorePublicUrl("https://lore.example.com:4443")).toBe(
      "grpcs://lore.example.com:4443",
    );
    expect(normalizeLorePublicUrl("http://192.168.1.20")).toBe(
      "grpc://192.168.1.20:80",
    );
    expect(normalizeLorePublicUrl("lores://lore.example.com")).toBe(
      "lores://lore.example.com:443",
    );
    expect(normalizeLorePublicUrl("lore://lore.example.com")).toBe(
      "lore://lore.example.com:3000",
    );
  });

  it("derives one unified Web and Lore address", () => {
    expect(normalizeUnifiedSiteAddress("localhost:3000")).toEqual({
      webPublicUrl: "http://localhost:3000",
      lorePublicUrl: "lore://localhost:3000",
    });
    expect(normalizeUnifiedSiteAddress("lore.example.com")).toEqual({
      webPublicUrl: "https://lore.example.com",
      lorePublicUrl: "lores://lore.example.com:443",
    });
  });

  it("checks the certificate hostname and private-key pair", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-cert-test-"));
    const certificatePath = path.join(directory, "cert.pem");
    const privateKeyPath = path.join(directory, "key.pem");
    try {
      execFileSync("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "1",
        "-keyout",
        privateKeyPath,
        "-out",
        certificatePath,
        "-subj",
        "/CN=lore.example.com",
        "-addext",
        "subjectAltName=DNS:lore.example.com",
      ]);
      const certificateChain = readFileSync(certificatePath, "utf8");
      const privateKey = readFileSync(privateKeyPath, "utf8");
      await expect(
        validateLoreCertificate({
          lorePublicUrl: "lores://lore.example.com:41337",
          certificateChain,
          privateKey,
        }),
      ).resolves.toBeUndefined();
      await expect(
        validateLoreCertificate({
          lorePublicUrl: "lores://other.example.com:41337",
          certificateChain,
          privateKey,
        }),
      ).rejects.toThrow(
        "Lore certificate does not cover the Lore address hostname",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
