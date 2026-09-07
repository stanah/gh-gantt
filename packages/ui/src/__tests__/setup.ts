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

// React Flow (@xyflow/react) を jsdom で描画するための polyfill。
// 公式のテストガイド (https://reactflow.dev/learn/advanced-use/testing) に倣い、
// ResizeObserver / DOMMatrixReadOnly と要素寸法を最小限に模倣する。
if (globalThis.window !== undefined) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  if (typeof globalThis.ResizeObserver === "undefined") {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: ResizeObserverStub,
    });
  }

  class DOMMatrixReadOnlyStub {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([1-9.\d]+)\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  if (typeof globalThis.DOMMatrixReadOnly === "undefined") {
    Object.defineProperty(globalThis, "DOMMatrixReadOnly", {
      configurable: true,
      writable: true,
      value: DOMMatrixReadOnlyStub,
    });
  }

  // jsdom はレイアウトを計算しないため、ノード寸法が 0 になりエッジが描画されない。
  // 未定義の場合のみ固定値 (150 x 30) を返す getter を与える。
  // 注意: この上書きは UI の全テストに効く。React Flow の store も表示領域をこの値で計測する。
  const proto = globalThis.HTMLElement.prototype;
  const offsetHeight = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  const offsetWidth = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
  if (!offsetHeight || offsetHeight.get?.call(document.createElement("div")) === 0) {
    Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 30 });
  }
  if (!offsetWidth || offsetWidth.get?.call(document.createElement("div")) === 0) {
    Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => 150 });
  }
}
