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

// The permission model is handed in rather than imported: this tool only exists
// where the platform has one, and which platform that is belongs to the seam.
// No OS-specific module is reachable from here.

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
 * @param permission - the platform's permission model. This tool is registered
 *   only where one exists, so it is required rather than optional.
 * @param readSettings - reads the current plugin settings. A reader rather than
 *   the settings themselves, because these values can change while the host is
 *   running — see `apply()` in index.mjs.
 * @param issues - problems recorded while mounting; may still be filled in
 *   after this definition is built, since registration order decides that.
 * @returns the tool definition.
 */
export function screenPermissionTool(permission, readSettings, issues = []) {
  return defineTool({
    name: 'screen_permission',
    description: [
      'Check whether this macOS process is allowed to capture the screen, and get the exact steps to fix it when it is not.',
      'Call it with action "check" to diagnose a refused screenshot, or with action "guide" to walk the user through fixing it — it checks first, opens the System Settings pane only when the grant really is missing, and returns the exact path to add.',
      'A refused capture is not a bug in the tool: macOS gates screen capture behind a user-granted permission that no program can grant on the user\'s behalf.',
    ].join(' '),
    parameters: {
      action: {
        type: 'string',
        enum: ['check', 'guide'],
        description:
          '"check" (default) reports whether capture is currently authorised and changes nothing. "guide" walks the user '
          + 'through fixing it: it checks first, opens the Screen Recording pane only when the grant really is missing, '
          + 'and returns the exact path to add. When the grant is already in place "guide" says so and opens nothing.',
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
      const target = permission.grantTarget();
      // Read at call time, not build time: a later registration may have
      // failed after this definition was constructed, and a setting may have
      // been edited since the host started.
      const reported = [...issues];
      const carried = reported.length === 0 ? {} : { issues: reported };
      const settings = readSettings();

      if (action === 'guide') {
        // Probe before opening. Opening the pane is the answer to a grant that
        // is missing, and reporting it missing without having looked would be
        // the plugin asserting what it never observed — which is the one thing
        // a guidance path must not do.
        const state = await permission.probe({ signal: exec.signal });
        if (state.authorized) {
          return {
            platform: process.platform,
            authorized: true,
            target,
            settingsOpened: false,
            ...carried,
          };
        }
        await permission.openSettings({ signal: exec.signal });
        return {
          platform: process.platform,
          authorized: false,
          ...(state.reason === undefined ? {} : { reason: state.reason }),
          ...(state.detail === undefined || state.detail === '' ? {} : { detail: state.detail }),
          target,
          settingsOpened: true,
          guidance: permission.guidance({ locale: settings.locale, target }),
          ...carried,
        };
      }

      const probe = await permission.probe({ signal: exec.signal });
      return {
        platform: process.platform,
        authorized: probe.authorized,
        ...(probe.reason === undefined ? {} : { reason: probe.reason }),
        ...(probe.detail === undefined || probe.detail === '' ? {} : { detail: probe.detail }),
        target,
        ...(probe.authorized
          ? {}
          : { guidance: permission.guidance({ locale: settings.locale, target }) }),
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
    ...(value.settingsOpened === true
      ? [
        '',
        'The grant cannot be made on the user\'s behalf, so this is as far as the tool goes. When they say they have '
        + 'done it, call this tool with action "check" to confirm before capturing again — do not assume it worked.',
      ]
      : []),
    ...issueLines,
    '</screen_permission>',
  ];
  return lines.join('\n');
}
