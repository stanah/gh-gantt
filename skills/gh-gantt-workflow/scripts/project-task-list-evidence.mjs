import process from "node:process";

const DEFAULT_LIMIT = 50;
const DEFAULT_STATUS_FIELD = "Status";

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

function parseOptions(args) {
  let limit = DEFAULT_LIMIT;
  let statusField = DEFAULT_STATUS_FIELD;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option === "--limit") {
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
        fail("limit は 1 以上の整数が必要です。");
      }
      limit = Number(value);
      index += 1;
    } else if (option === "--status-field") {
      if (value === undefined || value.length === 0) {
        fail("status-field には空でないフィールド名が必要です。");
      }
      statusField = value;
      index += 1;
    } else {
      fail(`未対応の引数です: ${option}`);
    }
  }

  return { limit, statusField };
}

function validateTask(task, index) {
  const valid =
    task !== null &&
    typeof task === "object" &&
    !Array.isArray(task) &&
    typeof task.id === "string" &&
    (task.github_issue === null || Number.isInteger(task.github_issue)) &&
    typeof task.title === "string" &&
    typeof task.state === "string" &&
    task.custom_fields !== null &&
    typeof task.custom_fields === "object" &&
    !Array.isArray(task.custom_fields);
  if (!valid) {
    fail(`task の形式が不正です (index: ${index})。`);
  }
}

const { limit, statusField } = parseOptions(process.argv.slice(2));
let input;
try {
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) {
    source += chunk;
  }
  input = JSON.parse(source);
} catch {
  fail("不正な JSON です。");
}

if (input === null || typeof input !== "object" || !Array.isArray(input.tasks)) {
  fail("入力には tasks 配列が必要です。");
}

input.tasks.forEach(validateTask);
const tasks = input.tasks.slice(0, limit).map((task) => ({
  id: task.id,
  github_issue: task.github_issue,
  title: task.title,
  status: task.custom_fields[statusField] ?? null,
  state: task.state,
}));

console.log(
  JSON.stringify({
    total: input.tasks.length,
    limit,
    truncated: input.tasks.length > limit,
    tasks,
  }),
);
