function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function isUsableStorage(storage: unknown): storage is Storage {
  if (
    typeof storage !== "object" ||
    storage === null ||
    !("clear" in storage) ||
    !("getItem" in storage) ||
    !("setItem" in storage)
  ) {
    return false;
  }

  try {
    const candidate = storage as Storage;
    candidate.setItem("__gh_gantt_test__", "1");
    candidate.removeItem("__gh_gantt_test__");
    return true;
  } catch {
    return false;
  }
}

const storage = isUsableStorage(globalThis.window?.localStorage)
  ? globalThis.window.localStorage
  : createMemoryStorage();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: storage,
});

if (globalThis.window !== undefined) {
  Object.defineProperty(globalThis.window, "localStorage", {
    configurable: true,
    value: storage,
  });
}
