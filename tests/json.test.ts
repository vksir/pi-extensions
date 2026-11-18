import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { updateJsonFile } from "../extensions/lib/json.ts";

const LIB_URL = new URL("../extensions/lib/json.ts", import.meta.url).href;

interface Counter {
	count: number;
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-json-"));
}

/** 子进程里跑 N 次「读-加一-写」，制造真实的跨进程竞争。 */
function incrementInChild(file: string, times: number): Promise<void> {
	const script = `
		const { updateJsonFile } = await import(${JSON.stringify(LIB_URL)});
		for (let i = 0; i < ${times}; i += 1) {
			updateJsonFile(process.env.COUNTER_FILE, { count: 0 }, (current) => ({ count: current.count + 1 }));
		}
	`;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
			env: { ...process.env, COUNTER_FILE: file },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`child exited with ${code}: ${stderr}`)),
		);
	});
}

test("updateJsonFile：多个进程同时读-改-写不丢增量", { timeout: 60_000 }, async () => {
	const dir = tempDir();
	const file = join(dir, "counter.json");
	try {
		// 3 个进程各加 25 次；没有锁时后写的会把先写的增量覆盖掉
		await Promise.all([incrementInChild(file, 25), incrementInChild(file, 25), incrementInChild(file, 25)]);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), { count: 75 });
		assert.equal(existsSync(`${file}.lock`), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("updateJsonFile：回收崩溃进程留下的过期锁", () => {
	const dir = tempDir();
	const file = join(dir, "counter.json");
	try {
		writeFileSync(`${file}.lock`, "dead-process");
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${file}.lock`, old, old);

		updateJsonFile<Counter>(file, { count: 0 }, (current) => ({ count: current.count + 1 }));
		assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), { count: 1 });
		assert.equal(existsSync(`${file}.lock`), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("updateJsonFile：坏文件退回默认值，更新抛错时原文件不动", () => {
	const dir = tempDir();
	const file = join(dir, "counter.json");
	try {
		writeFileSync(file, "{ broken");
		updateJsonFile<Counter>(file, { count: 0 }, (current) => ({ count: current.count + 2 }));
		assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), { count: 2 });

		assert.throws(
			() =>
				updateJsonFile<Counter>(file, { count: 0 }, () => {
					throw new Error("boom");
				}),
			/boom/,
		);
		// 更新中途抛错：文件保持上一步的内容，锁照样释放
		assert.deepEqual(JSON.parse(readFileSync(file, "utf-8")), { count: 2 });
		assert.equal(existsSync(`${file}.lock`), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
