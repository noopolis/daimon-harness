import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  AuthStorage,
  createBashTool,
  createAgentSession,
  type ModelRegistry,
  SessionManager,
  SettingsManager,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type { createMemoryRuntime, MemoryAuthorityConfig } from "@noopolis/mneme";

import type { AgentHandle, AgentHarnessAdapter, AgentStartInput, HarnessModelSpec } from "../core/types.js";
import { resolveRunId } from "../observability/causalEvents.js";

import { resolvePiHarnessModel } from "./modelConfig.js";
import { createPiModelRegistry } from "./modelRegistry.js";
import { createPiMemoryTools, piMemoryToolNames, type PiMemoryToolContextRef } from "./memoryTools.js";
import { createResourceLoader } from "./prompts.js";
import { PiAgentHandle, type PiNativeSessionCreator, type PiSessionCreator, type PiSessionLike } from "./piAgentHandle.js";
import { type PiWakeEnvironmentContextRef } from "./piAgentWakeSupport.js";
import { DAIMON_WAKE_ID_ENV } from "./cliEnvironment.js";
import { createPiWorldTools, piWorldToolNames, type PiWorldBinding } from "./worldTools.js";
import type { PiWorldToolContextRef } from "./worldNudge.js";
import { ensureRuntimeHome, ensureRuntimeHomeDirectory } from "../runtime/runtimeHomeLayout.js";
import { readyTaskClockEnvironment } from "../runtime/taskClockProcess.js";
import { readTaskClock, taskClockChildEnvironment, taskClockProcessEnvironment } from "../runtime/taskClock.js";
import { createClockedMemoryRuntime, memoryClockOptions } from "./memoryClock.js";
import { verifyTaskClockProcess, type TaskClockProcessProbe } from "./taskClockProcess.js";
import {
  bindPiRawTrainingCapture,
  validatePiRawTrainingCaptureOptions,
  type PiRawTrainingCaptureOptions,
  type PiRawTrainingCaptureRef
} from "./rawTrainingCapture.js";

type HarnessMemoryEmbeddingProvider = {
  dimensions?: number;
  embed(text: string): Promise<number[]>;
};

export type PiThinkingLevel = NonNullable<
  NonNullable<Parameters<typeof createAgentSession>[0]>["thinkingLevel"]
>;

type PiHarnessBaseOptions = {
  authPath: string;
  model?: {
    auth?: HarnessModelSpec["auth"];
    endpoint?: HarnessModelSpec["endpoint"];
    provider: string;
    name: string;
  };
  modelsPath?: string;
  /** Host-only names removed from every engine and Pi bash child environment. */
  protectedEnvironmentNames?: readonly string[];
  memory?: {
    authority?: MemoryAuthorityConfig;
    embeddingProvider?: HarnessMemoryEmbeddingProvider;
    source?: string;
    tokenBudget?: number;
    runtimeHomePath?: string;
  };
  thinkingLevel?: PiThinkingLevel;
  world?: PiWorldBinding;
  productionTools?: readonly ToolDefinition[];
  /** Engine-owned default; an empty list disables Pi builtins for confined CLI engines. */
  toolNames?: readonly string[];
  wakeEnvironmentContext?: PiWakeEnvironmentContextRef;
};

export type PiHarnessOptions = PiHarnessBaseOptions & (
  | {
    rawTrainingCapture?: PiRawTrainingCaptureOptions;
    sessionFactory?: never;
  }
  | {
    rawTrainingCapture?: never;
    sessionFactory: PiSessionFactory;
  }
);

export type PiSessionFactoryInput = Exclude<Parameters<typeof createAgentSession>[0], undefined> & {
  daimonSecretEnvironmentNames?: readonly string[];
  /** The isolated runtime home assigned by Daimon to this one agent. */
  runtimeHomePath?: string;
};

export type PiSessionFactory = (input: PiSessionFactoryInput) => Promise<{ session: PiSessionLike }>;

export class PiHarnessAdapter implements AgentHarnessAdapter {
  static readonly capabilities = Object.freeze({ causalRunId: true, memoryCausalRunId: false });
  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly sessionFactory: PiSessionFactory;

  constructor(private readonly options: PiHarnessOptions, /** @internal */ private readonly taskClockProbe?: TaskClockProcessProbe) {
    this.authStorage = AuthStorage.create(options.authPath);
    this.modelRegistry = createPiModelRegistry(this.authStorage, options);
    this.sessionFactory = options.sessionFactory ?? createAgentSession;
  }

  async startAgent(input: AgentStartInput): Promise<AgentHandle> {
    const taskClock = readTaskClock();
    if (this.options.memory !== undefined) memoryClockOptions(taskClock);
    if (input.causalRunId !== undefined && this.options.memory !== undefined) {
      throw new Error("Per-agent causalRunId requires a memory runtime with explicit causal context; configured memory is currently unsupported");
    }
    const causalRunId = input.causalRunId === undefined ? undefined : resolveRunId(undefined, input.causalRunId);
    validatePiRawTrainingCaptureOptions(this.options.rawTrainingCapture);
    await verifyTaskClockProcess(input.runtimeHomePath, taskClock, this.taskClockProbe);
    await ensureRuntimeHome(input.runtimeHomePath);
    await Promise.all([".config", ".local/share", ".local/state", ".cache", ".tmp", "tool-state"]
      .map((relative) => ensureRuntimeHomeDirectory(input.runtimeHomePath, relative)));
    await mkdir(input.workspacePath, { recursive: true });
    const memoryRuntimeHomePath = this.options.memory?.runtimeHomePath ?? input.runtimeHomePath;
    await ensureRuntimeHome(memoryRuntimeHomePath);
    const modelSpec = this.options.model ?? {
      auth: { method: "codex" as const },
      provider: "openai",
      name: "gpt-5.4-mini"
    };
    const resolvedModel = resolvePiHarnessModel(modelSpec).model;
    const model = this.modelRegistry.find(resolvedModel.provider, resolvedModel.name);
    if (!model) {
      throw new Error(`Pi model not found: ${resolvedModel.provider}/${resolvedModel.name}`);
    }
    const memory = this.options.memory === undefined
      ? undefined
      : createClockedMemoryRuntime({
        agentId: input.id,
        authority: this.options.memory.authority,
        embeddingProvider: this.options.memory.embeddingProvider,
        runtimeHomePath: memoryRuntimeHomePath,
        source: this.options.memory.source,
        tokenBudget: this.options.memory.tokenBudget
      } as Parameters<typeof createMemoryRuntime>[0] & {
        embeddingProvider?: HarnessMemoryEmbeddingProvider;
      }, taskClock);
    const memoryToolContext: PiMemoryToolContextRef | undefined =
      memory === undefined ? undefined : {};
    const worldToolContext: PiWorldToolContextRef | undefined =
      this.options.world === undefined ? undefined : {};
    const rawTrainingCaptureRef: PiRawTrainingCaptureRef | undefined =
      this.options.rawTrainingCapture === undefined ? undefined : {};
    const wakeEnvironmentContext: PiWakeEnvironmentContextRef = this.options.wakeEnvironmentContext ?? {};
    // Fixed for the life of this agent, not per wake: whether it can publish
    // through `moltnet_send` at all. Gates the terminal-text fallback in
    // `PiAgentHandle.runWake` (see `PiWakeEnvironmentContextRef.hasSendCapability`).
    wakeEnvironmentContext.hasSendCapability = (this.options.productionTools ?? []).some((tool) => tool.name === "moltnet_send");
    const sessionInput = (mode: Parameters<PiSessionCreator>[0], sessionDirectory: string) => {
      const memoryTools = memory === undefined || memoryToolContext === undefined
        ? []
        : createPiMemoryTools({
          agentId: input.id,
          memory,
          contextRef: memoryToolContext,
          mode
        });
      const worldTools = this.options.world === undefined
        ? undefined
        : createPiWorldTools({
          world: this.options.world,
          contextRef: worldToolContext
        });
      // Every child tool inherits the same denylist: host control values,
      // Daimon-held world/model secrets, and caller-protected names.
      const protectedNames = [...new Set([
        ...(this.options.protectedEnvironmentNames ?? []),
        ...(this.options.world === undefined ? [] : [this.options.world.tokenEnv])
      ])];
      const requestedTools = this.options.toolNames ?? input.tools;
      const protectedBash = (protectedNames.length === 0 && taskClock === undefined) || requestedTools?.includes("bash") === false
        ? []
        : [createProtectedBashTool(input.workspacePath, input.runtimeHomePath, protectedNames, wakeEnvironmentContext, taskClockChildEnvironment({}, taskClock))];
      const toolNames = [
        ...(requestedTools ?? ["read", "write", "edit", "bash", "grep", "find", "ls"]),
        ...piMemoryToolNames(memoryTools),
        ...(worldTools === undefined ? [] : piWorldToolNames(worldTools))
        ,...(this.options.productionTools ?? []).map((tool) => tool.name)
      ];

      return {
        cwd: input.workspacePath,
        agentDir: input.runtimeHomePath,
        runtimeHomePath: input.runtimeHomePath,
        daimonSecretEnvironmentNames: this.options.world === undefined ? [] : [this.options.world.tokenEnv],
        authStorage: this.authStorage,
        modelRegistry: this.modelRegistry,
        model,
        thinkingLevel: this.options.thinkingLevel ?? "off",
        resourceLoader: createResourceLoader(input, mode, {
          memory: memory !== undefined,
          world: worldTools !== undefined
        }),
        tools: [...new Set(toolNames)],
        customTools: worldTools === undefined
          ? [...protectedBash, ...memoryTools, ...(this.options.productionTools ?? [])]
          : [...protectedBash, ...memoryTools, ...worldTools, ...(this.options.productionTools ?? [])],
        sessionManager: SessionManager.create(input.workspacePath, sessionDirectory),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 1 }
        })
      };
    };

    if (this.options.rawTrainingCapture !== undefined) {
      const createSession: PiNativeSessionCreator = async (mode, sessionDirectory) => {
        const { session } = await createAgentSession(sessionInput(mode, sessionDirectory));
        if (rawTrainingCaptureRef !== undefined) {
          bindPiRawTrainingCapture(session, rawTrainingCaptureRef);
        }
        return session;
      };
      const session = await createSession("awake", path.join(input.runtimeHomePath, "sessions"));
      return new PiAgentHandle(
        input.id,
        session,
        createSession,
        input.runtimeHomePath,
        {
          authMethod: modelSpec.auth?.method ?? "none",
          model: resolvedModel.name,
          provider: resolvedModel.provider
        },
        memory,
        memoryToolContext,
        { causalRunId },
        worldToolContext,
        rawTrainingCaptureRef,
        this.options.rawTrainingCapture,
        worldToolContext === undefined
          ? undefined
          : { instructions: input.instructions, thinkingLevel: this.options.thinkingLevel ?? "off" },
        session,
        wakeEnvironmentContext
      );
    }

    const createSession: PiSessionCreator = async (mode, sessionDirectory) => {
      const { session } = await (this.options.sessionFactory ?? createAgentSession)(sessionInput(mode, sessionDirectory));
      return session;
    };
    const session = await createSession("awake", path.join(input.runtimeHomePath, "sessions"));

    return new PiAgentHandle(
      input.id,
      session,
      createSession,
      input.runtimeHomePath,
      {
        authMethod: modelSpec.auth?.method ?? "none",
        model: resolvedModel.name,
        provider: resolvedModel.provider
      },
      memory,
      memoryToolContext,
      { causalRunId },
      worldToolContext,
      undefined,
      undefined,
      worldToolContext === undefined
        ? undefined
        : {
          instructions: input.instructions,
          thinkingLevel: this.options.thinkingLevel ?? "off"
        },
      undefined,
      wakeEnvironmentContext
    );
  }
}

function createProtectedBashTool(
  workspacePath: string,
  runtimeHomePath: string,
  protectedNames: readonly string[],
  wakeEnvironmentContext: PiWakeEnvironmentContextRef,
  clockEnvironment: Record<string, string>
): ToolDefinition {
  const bash = createBashTool(workspacePath, {
    spawnHook: (context) => ({
      ...context,
      env: readyTaskClockEnvironment({
        ...Object.fromEntries(Object.entries(taskClockProcessEnvironment(context.env, clockEnvironment)).filter(([name]) => !protectedNames.includes(name))),
        HOME: runtimeHomePath,
        XDG_CONFIG_HOME: `${runtimeHomePath}/.config`,
        XDG_DATA_HOME: `${runtimeHomePath}/.local/share`,
        XDG_STATE_HOME: `${runtimeHomePath}/.local/state`,
        XDG_CACHE_HOME: `${runtimeHomePath}/.cache`,
        TMPDIR: `${runtimeHomePath}/.tmp`,
        ...clockEnvironment,
        ...(wakeEnvironmentContext.current === undefined
          ? {}
          : { [DAIMON_WAKE_ID_ENV]: wakeEnvironmentContext.current })
      })
    })
  });
  return {
    name: bash.name,
    label: bash.label,
    description: bash.description,
    parameters: bash.parameters,
    ...(bash.prepareArguments === undefined ? {} : { prepareArguments: bash.prepareArguments }),
    ...(bash.executionMode === undefined ? {} : { executionMode: bash.executionMode }),
    async execute(toolCallId, params, signal, onUpdate) {
      return bash.execute(toolCallId, params as Parameters<typeof bash.execute>[1], signal, onUpdate);
    }
  } as ToolDefinition;
}
