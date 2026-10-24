import { mock } from "bun:test";

// The SDK test host imports better-sqlite3 for `bb.storage.database()`, which
// this plugin never uses (it only uses `bb.storage.kv`). Bun cannot load that
// native module, so stand in a constructor that fails loudly if ever called.
mock.module("better-sqlite3", () => ({
  default: class {
    constructor() {
      throw new Error("bb.storage.database() is not used by provider-retry-advanced");
    }
  },
}));
