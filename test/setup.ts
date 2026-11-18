import { mock } from "bun:test";

mock.module("better-sqlite3", () => ({
  default: class {
    constructor() {
      throw new Error("bb.storage.database() is not used by provider-retry-advanced");
    }
  },
}));
