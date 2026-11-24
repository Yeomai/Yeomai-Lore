import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { SessionService } from "../src/auth/session.ts";
import { loadConfig } from "../src/config.ts";
import { createDatabase } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { seedInitialAdmin } from "../src/db/seed.ts";
import { setSystemSetting } from "../src/settings.ts";

describe("certificate administration", () => {
  it("uploads a valid public certificate without exposing the private key", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-certificate-test-"));
    const certificatePath = path.join(directory, "upload.crt");
    const privateKeyPath = path.join(directory, "upload.key");
    const caCertificatePath = path.join(directory, "ca.crt");
    const caPrivateKeyPath = path.join(directory, "ca.key");
    const storedCertificatePath = path.join(directory, "certs", "lore.crt");
    const storedPrivateKeyPath = path.join(directory, "certs", "lore.key");
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    const config = loadConfig({
      NODE_ENV: "test",
      OIDC_KEY_DIR: path.join(directory, "keys"),
      LORE_CA_FILE: caCertificatePath,
      LORE_CA_KEY_FILE: caPrivateKeyPath,
      LORE_QUIC_TLS_CERT_FILE: storedCertificatePath,
      LORE_QUIC_TLS_KEY_FILE: storedPrivateKeyPath,
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
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
        caPrivateKeyPath,
        "-out",
        caCertificatePath,
        "-subj",
        "/CN=Lore Test CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
      ]);
      await migrate(db);
      await seedInitialAdmin(db, config);
      const admin = await db.query<{ id: string }>(
        "SELECT id FROM users WHERE username = 'admin'",
      );
      const session = new SessionService(db, config);
      const browserSession = await session.create(admin.rows[0]!.id);
      app = await buildApp({
        config,
        db,
        lore: {},
        session,
        tokens: {},
        oauth: {},
        mailer: { send: async () => {} },
        logger: false,
      } as never);
      const headers = {
        cookie: `lore_portal_session=${browserSession.token}`,
      };

      const local = await app.inject({
        method: "GET",
        url: "/api/v1/admin/certificate",
        headers,
      });
      expect(local.statusCode).toBe(200);
      expect(local.json()).toMatchObject({
        required: false,
        caAvailable: true,
        certificate: { configured: false },
      });
      const caDownload = await app.inject({
        method: "GET",
        url: "/api/v1/admin/certificate/ca",
        headers,
      });
      expect(caDownload.statusCode).toBe(200);
      expect(caDownload.headers["content-type"]).toContain(
        "application/x-pem-file",
      );
      expect(caDownload.body).toContain("BEGIN CERTIFICATE");
      expect(caDownload.body).not.toContain("PRIVATE KEY");

      await setSystemSetting(
        db,
        "lore_public_url",
        "lores://lore.example.com:41337",
      );
      const beforeUpload = await app.inject({
        method: "GET",
        url: "/api/v1/admin/certificate",
        headers,
      });
      expect(beforeUpload.json()).toMatchObject({
        required: true,
        certificate: { configured: false },
      });

      const certificateChain = readFileSync(certificatePath, "utf8");
      const privateKey = readFileSync(privateKeyPath, "utf8");
      const uploaded = await app.inject({
        method: "PUT",
        url: "/api/v1/admin/certificate",
        headers,
        payload: { certificateChain, privateKey },
      });
      expect(uploaded.statusCode).toBe(200);
      expect(uploaded.json()).toMatchObject({
        ok: true,
        certificate: {
          configured: true,
          invalid: false,
          subject: "CN=lore.example.com",
        },
      });
      expect(uploaded.body).not.toContain("BEGIN PRIVATE KEY");
      expect(readFileSync(storedCertificatePath, "utf8")).toBe(
        certificateChain.trim(),
      );
      expect(readFileSync(storedPrivateKeyPath, "utf8")).toBe(
        privateKey.trim(),
      );

      config.lorePublicUrl = "lores://118.89.28.163:3000";
      await setSystemSetting(
        db,
        "lore_public_url",
        "lores://118.89.28.163:3000",
      );
      const issued = await app.inject({
        method: "POST",
        url: "/api/v1/admin/certificate/ips",
        headers,
        payload: { ipAddresses: ["10.1.0.8"] },
      });
      expect(issued.statusCode).toBe(200);
      expect(issued.json()).toMatchObject({
        ok: true,
        ipAddresses: ["118.89.28.163", "10.1.0.8"],
        siteIpAddress: "118.89.28.163",
        additionalIpAddresses: ["10.1.0.8"],
      });
      const ipCertificate = new X509Certificate(
        readFileSync(storedCertificatePath),
      );
      expect(ipCertificate.checkIP("118.89.28.163")).toBe(
        "118.89.28.163",
      );
      expect(ipCertificate.checkIP("10.1.0.8")).toBe("10.1.0.8");
      expect(issued.body).not.toContain("BEGIN PRIVATE KEY");
    } finally {
      await app?.close();
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
