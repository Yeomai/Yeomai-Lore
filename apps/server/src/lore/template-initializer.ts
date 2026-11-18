import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  readIgnoreTemplate,
  type IgnoreTemplateId,
} from "../templates/loreignore.ts";

const run = promisify(execFile);

export interface InitializeRepositoryInput {
  loreCliPath: string;
  lorePublicUrl: string;
  repositoryName: string;
  identityToken: string;
  accessToken: string;
}

export interface InitializeIgnoreTemplateInput
  extends InitializeRepositoryInput {
  template: IgnoreTemplateId;
}

export type InitializeEmptyRepositoryInput = InitializeRepositoryInput;

export async function initializeEmptyRepository(
  input: InitializeEmptyRepositoryInput,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "lore-empty-repository-"));
  const repositoryPath = path.join(directory, "repository");

  try {
    await cloneRepository(input, repositoryPath);
    await lore(
      input.loreCliPath,
      ["revision", "metadata", "set", "initialized", "true"],
      input.identityToken,
      input.accessToken,
      repositoryPath,
    );
    await lore(
      input.loreCliPath,
      ["revision", "commit", "Initialize empty repository"],
      input.identityToken,
      input.accessToken,
      repositoryPath,
    );
    await lore(
      input.loreCliPath,
      ["push"],
      input.identityToken,
      input.accessToken,
      repositoryPath,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function initializeIgnoreTemplate(
  input: InitializeIgnoreTemplateInput,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "lore-ignore-template-"));
  const repositoryPath = path.join(directory, "repository");

  try {
    await cloneRepository(input, repositoryPath);
    await writeFile(
      path.join(repositoryPath, ".loreignore"),
      await readIgnoreTemplate(input.template),
      { flag: "wx" },
    );
    await lore(
      input.loreCliPath,
      ["stage", ".loreignore"],
      input.identityToken,
      input.accessToken,
      repositoryPath,
    );
    await lore(input.loreCliPath, [
      "commit",
      "Initialize project ignore template",
    ], input.identityToken, input.accessToken, repositoryPath);
    await lore(
      input.loreCliPath,
      ["push"],
      input.identityToken,
      input.accessToken,
      repositoryPath,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function cloneRepository(
  input: InitializeRepositoryInput,
  repositoryPath: string,
): Promise<void> {
  await lore(
    input.loreCliPath,
    [
      "clone",
      `${input.lorePublicUrl}/${input.repositoryName}`,
      repositoryPath,
    ],
    input.identityToken,
    input.accessToken,
  );
}

async function lore(
  executable: string,
  args: string[],
  identityToken: string,
  accessToken: string,
  cwd?: string,
): Promise<void> {
  try {
    await run(executable, args, {
      env: {
        ...process.env,
        LORE_IDENTITY_TOKEN: identityToken,
        LORE_ACCESS_TOKEN: accessToken,
      },
      ...(cwd ? { cwd } : {}),
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const stderr =
      typeof error === "object" && error && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    throw new Error(
      `Lore template initialization failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
}
