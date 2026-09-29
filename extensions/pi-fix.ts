import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Settings = Record<string, unknown>;

const settingsPath = path.join(getAgentDir(), "settings.json");

function updateSettings(update: (settings: Settings) => void): void {
  try {
    let settings: Settings = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("settings.json must contain a JSON object");
      }
      settings = parsed as Settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    update(settings);
    const temporaryPath = `${settingsPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    renameSync(temporaryPath, settingsPath);
  } catch (error) {
    console.error(`[pi-fix] Unable to update Pi defaults: ${String(error)}`);
  }
}

function saveModel(provider: string, modelId: string, thinkingLevel: string): void {
  updateSettings((settings) => {
    settings.defaultProvider = provider;
    settings.defaultModel = modelId;
    settings.defaultThinkingLevel = thinkingLevel;
  });
}

function saveThinkingLevel(thinkingLevel: string): void {
  updateSettings((settings) => {
    settings.defaultThinkingLevel = thinkingLevel;
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("model_select", (event) => {
    // Session restoration must not rewrite defaults; explicit selections should.
    if (event.source === "restore") return;
    saveModel(event.model.provider, event.model.id, pi.getThinkingLevel());
  });

  pi.on("thinking_level_select", (event, ctx) => {
      saveThinkingLevel(event.level);
  });
}
