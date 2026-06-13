import type { ToolDefinition, ToolContext } from './types.js';
import { discoverLogGroupsTool, queryLogsTool } from './cloudwatchLogs.js';
import { metricsAndAlarmsTool } from './cloudwatchMetrics.js';
import { albAccessLogsTool } from './albAccessLogs.js';
import { ecsServiceEventsTool } from './ecs.js';
import { listMetricsTool } from './listMetrics.js';
import { findAlarmsTool } from './alarms.js';
import { lambdaConfigurationTool, lambdaDeploymentMetadataTool } from './lambda.js';
import { eventBridgeRuleTool } from './eventbridge.js';
import { cloudTrailLookupTool } from './cloudtrail.js';

/**
 * Built-in read-only tools available to the Investigate stage.
 */
const BUILTIN_TOOLS: ToolDefinition[] = [
  discoverLogGroupsTool as ToolDefinition,
  queryLogsTool as ToolDefinition,
  metricsAndAlarmsTool as ToolDefinition,
  albAccessLogsTool as ToolDefinition,
  ecsServiceEventsTool as ToolDefinition,
  listMetricsTool as ToolDefinition,
  findAlarmsTool as ToolDefinition,
  lambdaConfigurationTool as ToolDefinition,
  cloudTrailLookupTool as ToolDefinition,
  eventBridgeRuleTool as ToolDefinition,
  lambdaDeploymentMetadataTool as ToolDefinition,
];

export function getTools(): ToolDefinition[] {
  return BUILTIN_TOOLS;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Map tool definitions to the OpenAI-compatible `tools` request payload.
 */
export function toOpenAITools(tools: ToolDefinition[] = getTools()): OpenAITool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersJsonSchema,
    },
  }));
}

const TRUNCATION_MARKER = '…[truncated]';

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return TRUNCATION_MARKER;
  }
  if (text.length <= maxChars) {
    return text;
  }
  const keep = Math.max(0, maxChars - TRUNCATION_MARKER.length);
  return text.slice(0, keep) + TRUNCATION_MARKER;
}

/**
 * Execute a model-requested tool call and return text for the model.
 *
 * Errors are returned as strings, never thrown: an unknown tool, malformed
 * arguments, schema-invalid arguments, or a handler failure all yield a
 * descriptive message so the tool loop can continue (and the model can correct
 * itself) instead of crashing the stage. The handler result is truncated to
 * `ctx.maxResultChars`.
 */
export async function dispatchToolCall(
  name: string,
  rawArgsJson: string,
  ctx: ToolContext,
  tools: ToolDefinition[] = getTools()
): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    const available = tools.map((t) => t.name).join(', ') || '(none)';
    return `Error: unknown tool "${name}". Available tools: ${available}.`;
  }

  let parsedArgs: unknown;
  try {
    parsedArgs = rawArgsJson.trim() === '' ? {} : JSON.parse(rawArgsJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: tool "${name}" received arguments that are not valid JSON: ${message}`;
  }

  const validated = tool.argsSchema.safeParse(parsedArgs);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const path = issue ? issue.path.join('.') : 'unknown';
    const detail = issue?.message ?? 'validation failed';
    return `Error: invalid arguments for tool "${name}" (at: ${path}): ${detail}`;
  }

  try {
    const result = await tool.handler(validated.data, ctx);
    return truncate(result, ctx.maxResultChars);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Error: tool "${name}" failed: ${message}`;
  }
}
