const { appendFile, mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const { dirname } = require("node:path");

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

class JsonlEventStore {
  constructor(path) {
    this.path = path;
  }

  async append(event) {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(
      this.path,
      `${JSON.stringify(event, jsonReplacer)}\n`,
      "utf8"
    );
  }
}

class JsonFileStateStore {
  constructor(path) {
    this.path = path;
  }

  async save(state) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    await writeFile(
      temporaryPath,
      JSON.stringify(state, jsonReplacer, 2),
      "utf8"
    );
    await rename(temporaryPath, this.path);
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }
}

class NullEventStore {
  async append() { }
}

class NullStateStore {
  async save() { }
  async load() {
    return null;
  }
}
module.exports = {
  JsonFileStateStore,
  NullStateStore,
  JsonlEventStore,
  jsonReplacer,
  NullEventStore
}