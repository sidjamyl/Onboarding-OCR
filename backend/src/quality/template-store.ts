import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OrbTemplate, OrbTemplateSummary } from "./types.js";
import { fromOcrTemplate } from "./ocr-template.js";

export class FileTemplateStore {
  constructor(
    private readonly directory: string,
    private readonly bundledDirectory?: string,
  ) {}

  private directories() {
    return [...new Set([this.directory, this.bundledDirectory].filter((value): value is string => Boolean(value)))];
  }

  private async names() {
    const groups = await Promise.all(
      this.directories().map(async (directory) => {
        try {
          return await readdir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }
      }),
    );
    return [...new Set(groups.flat())].filter((name) => name.endsWith(".json"));
  }

  async get(id: string): Promise<OrbTemplate | null> {
    if (!/^[a-z0-9][a-z0-9-]{1,100}$/i.test(id)) return null;
    for (const directory of this.directories()) {
      try {
        const path = join(directory, `${id}.json`);
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (parsed && typeof parsed === "object" && "formatVersion" in parsed) {
          const metadata = await stat(path);
          const template = fromOcrTemplate(parsed, metadata.mtime.toISOString());
          if (template.id !== id) throw new Error(`Template file name does not match ID: ${id}`);
          return template;
        }
        return parsed as OrbTemplate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return null;
  }

  async put(template: OrbTemplate): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await atomicWrite(join(this.directory, `${template.id}.json`), `${JSON.stringify(template, null, 2)}\n`);
  }

  async putImage(template: OrbTemplate, image: Buffer): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await atomicWrite(join(this.directory, template.image.fileName), image);
  }

  async getImage(id: string): Promise<{ data: Buffer; mimeType: OrbTemplate["image"]["mimeType"] } | null> {
    const template = await this.get(id);
    if (!template) return null;
    for (const directory of this.directories()) {
      try {
        return { data: await readFile(join(directory, template.image.fileName)), mimeType: template.image.mimeType };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return null;
  }

  async list(): Promise<OrbTemplateSummary[]> {
    const templates = (await Promise.all((await this.names()).map((name) => this.get(name.slice(0, -5))))).filter(
      (template): template is OrbTemplate => Boolean(template),
    );
    return templates
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((template) => ({
        id: template.id,
        name: template.name,
        documentKind: template.documentKind,
        version: template.version,
        width: template.width,
        height: template.height,
        zoneCount: template.zones.length,
        ignoredRegionCount: template.ignoredRegions.length,
        keypointCount: template.orb.rows,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      }));
  }

  async delete(id: string): Promise<boolean> {
    let template: OrbTemplate | null;
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8"));
      if (raw && typeof raw === "object" && "formatVersion" in raw) return false;
      template = await this.get(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!template) return false;
    await Promise.all([
      unlink(join(this.directory, `${id}.json`)),
      unlink(join(this.directory, template.image.fileName)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      }),
    ]);
    return true;
  }

  async findVariants(baseId: string): Promise<OrbTemplate[]> {
    const files = (await this.names()).filter((name) => name === `${baseId}.json` || name.startsWith(`${baseId}-`));
    return (await Promise.all(files.map((name) => this.get(name.slice(0, -5))))).filter(
      (template): template is OrbTemplate => Boolean(template),
    );
  }
}

async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, data);
  await rename(temporaryPath, path);
}
