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
 * @param settings - resolved plugin settings.
 * @returns the tool definition.
 */
export function screenPermissionTool(settings) {
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
          guidance: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPermission(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const action = args.action ?? 'check';
      const target = grantTargetPath();

      if (action === 'open_settings') {
        await openScreenRecordingSettings({ signal: exec.signal });
        return {
          platform: process.platform,
          authorized: false,
          target,
          settingsOpened: true,
          guidance: guidance({ locale: settings.locale, target }),
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
  if (value.authorized) {
    return `<screen_permission>
<authorized>true</authorized>
<platform>${value.platform}</platform>
Screen Recording is granted: the screenshot tool will work.
</screen_permission>`;
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
    '</screen_permission>',
  ];
  return lines.join('\n');
}
