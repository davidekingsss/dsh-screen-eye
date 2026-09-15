/**
 * The `screen_permission` tool: let the agent diagnose and fix its own
 * blindness.
 *
 * This exists because the remedy for a denied capture is a *user* action that
 * cannot be automated. An agent that can only report "capture failed" leaves
 * the user guessing; an agent that can report "capture failed, here is the
 * exact path to add, and here is the pane" gets unblocked in one exchange.
 * @module dsh-screen-eye/permission-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import {
  grantTargetPath,
  guidance,
  openScreenRecordingSettings,
  probeScreenRecording,
} from './permission.mjs';

/**
 * Build the `screen_permission` tool definition.
 *
 * `issues` is how a failure elsewhere in the plugin becomes discoverable. The
 * harness does not echo plugin logger output by default — verified, not
 * assumed: a canary at `error` level does not appear in `dsh web`'s output —
 * so a tool that failed to register would otherwise be a plugin that quietly
 * does less than it claims. This tool is the one an agent reaches for when the
 * screen misbehaves, so it is the one that reports the problem.
 *
 * @param settings - resolved plugin settings.
 * @param issues - problems recorded while mounting; may still be filled in
 *   after this definition is built, since registration order decides that.
 * @returns the tool definition.
 */
export function screenPermissionTool(settings, issues = []) {
  return defineTool({
    name: 'screen_permission',
    description: [
      'Check whether this macOS process is allowed to capture the screen, and get the exact steps to fix it when it is not.',
      'Call it with action "check" to diagnose a refused screenshot, or with action "open_settings" to open the System Settings pane the grant lives in.',
      'A refused capture is not a bug in the tool: macOS gates screen capture behind a user-granted permission that no program can grant on the user\'s behalf.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['check', 'open_settings'],
        description:
          '"check" (default) reports whether capture is currently authorised. "open_settings" opens the Screen Recording pane of System Settings for the user.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          platform: { type: 'string', required: true },
          authorized: { type: 'boolean', required: true },
          reason: { type: 'string' },
          detail: { type: 'string' },
          target: { type: 'string', required: true },
          settingsOpened: { type: 'boolean' },
          issues: { type: 'array', items: { type: 'string' } },
          guidance: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPermission(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const action = args.action ?? 'check';
      const target = grantTargetPath();
      // Read at call time, not build time: a later registration may have
      // failed after this definition was constructed.
      const reported = [...issues];
      const carried = reported.length === 0 ? {} : { issues: reported };

      if (action === 'open_settings') {
        await openScreenRecordingSettings({ signal: exec.signal });
        return {
          platform: process.platform,
          authorized: false,
          target,
          settingsOpened: true,
          guidance: guidance({ locale: settings.locale, target }),
          ...carried,
        };
      }

      const probe = await probeScreenRecording({ signal: exec.signal });
      return {
        platform: process.platform,
        authorized: probe.authorized,
        ...(probe.reason === undefined ? {} : { reason: probe.reason }),
        ...(probe.detail === undefined || probe.detail === '' ? {} : { detail: probe.detail }),
        target,
        ...(probe.authorized
          ? {}
          : { guidance: guidance({ locale: settings.locale, target }) }),
        ...carried,
      };
    },
  });
}

/**
 * Render the permission outcome as model-facing text.
 * @param value - the tool's canonical value.
 * @returns the text block content.
 */
function renderPermission(value) {
  const issueLines = value.issues === undefined
    ? []
    : ['', '<mount_issues>', ...value.issues.map((issue) => `  ${issue}`), '</mount_issues>'];
  if (value.authorized) {
    // Without issues this is a clean bill of health. With them, saying "the
    // screenshot tool will work" would be false — the permission is fine and
    // something else is not — so the sentence is dropped rather than softened.
    const verdict = value.issues === undefined
      ? 'Screen Recording is granted: the screenshot tool will work.'
      : 'Screen Recording is granted, but part of this plugin did not mount.';
    return [`<screen_permission>
<authorized>true</authorized>
<platform>${value.platform}</platform>
${verdict}`,
      ...issueLines,
      '</screen_permission>'].join('\n');
  }
  const lines = [
    '<screen_permission>',
    '<authorized>false</authorized>',
    `<platform>${value.platform}</platform>`,
    ...(value.reason === undefined ? [] : [`<reason>${value.reason}</reason>`]),
    ...(value.detail === undefined ? [] : [`<detail>${value.detail}</detail>`]),
    `<target>${value.target}</target>`,
    ...(value.settingsOpened === true
      ? ['The Screen Recording settings pane has been opened for the user.']
      : []),
    ...(value.guidance === undefined ? [] : ['', 'Tell the user exactly this:', ...value.guidance]),
    ...issueLines,
    '</screen_permission>',
  ];
  return lines.join('\n');
}
