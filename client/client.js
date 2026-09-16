/**
 * dsh-screen-eye — browser half.
 *
 * One settings section of its own: a row in the settings navigation with an eye
 * on it, and a page on the right with the plugin's seven settings. The Host side
 * registers the `screen-eye` settings namespace (`index.mjs`); this file binds
 * that namespace through `ctx.settingsScope` and contributes the page.
 *
 * ## Why this file is hand-written and has no build step
 *
 * A client half is a classic script that registers itself on
 * `window.__ModuleLoader__.load`, and that is small enough to write directly. A
 * bundler would buy two things this file does not need — JSX and dependency
 * resolution — at the cost of a build artifact that has to be rebuilt and kept
 * in step with a plugin that otherwise has no build at all. So the elements are
 * `React.createElement` calls and everything else arrives through the module
 * table the deployment already serves.
 *
 * What it must NOT do is import the harness's own components. The client
 * bundle-purity gate forbids cross-plugin value imports, so the page draws its
 * own chrome — the same design tokens (`--dsw-alias-*`), the same measurements,
 * its own class names — and registers its own dictionaries for its own copy.
 *
 * ## The one thing the platform does not offer: an icon
 *
 * The `settings.section` contract projects `id`, `order` and `label` and nothing
 * else, and the settings shell picks a section's glyph from a closed list of
 * built-in ids — anything it does not recognise gets the generic gear. There is
 * no icon field to set. So the row is claimed after it mounts: the plugin marks
 * the nav button whose label is its own, and a stylesheet hides the shell's gear
 * and draws an eye in its place as a `currentColor` mask, which keeps the
 * shell's hover and active colours and its 16px rhythm. The marker is removed on
 * disposal and carries no shell structure, so nothing here depends on where the
 * shell puts its nodes — only on the label the registrant itself supplied.
 *
 * @module dsh-screen-eye/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-screen-eye',
  factory: (require) => {
    const React = require('react');

    const h = React.createElement;

    /** The settings namespace this page edits; `index.mjs` owns the same string. */
    const NAMESPACE = 'screen-eye';

    /** Locale namespace for this page's own copy. */
    const LOCALE_NS = 'screen-eye';

    /** Attribute marking this plugin's own row in the settings navigation. */
    const NAV_MARKER = 'data-dsh-screen-eye-settings-nav';

    /**
     * Lucide's `eye`, as a mask so the glyph takes the nav row's own colour.
     * Percent-encoded because it rides inside a `url()` in a stylesheet.
     */
    const EYE_SVG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0'/%3E%3Ccircle cx='12' cy='12' r='3'/%3E%3C/svg%3E";

    const EN = {
      nav: 'Screen Eye',
      title: 'Screen Eye',
      intro: 'Screen vision for the agent: where captures land, how many are kept, and what a call may cost. Changes apply to the next capture — no restart.',
      changed: 'changed',
      reset: 'Reset',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      unsaved: 'Unsaved changes',
      saveFailed: 'The host did not accept that change. Your edit is still here — correct it and save again.',
      invalid: 'Not a value this field takes.',
      readOnly: 'This deployment keeps preferences in memory, so changes cannot be saved.',
      locale: 'Language',
      localeHint: 'The language of the Screen Recording onboarding text the tools return.',
      outputDir: 'Capture directory',
      outputDirHint: 'Where captured PNGs are written. Empty uses a "Screen Eye" folder inside the system pictures folder.',
      keepRecent: 'Captures kept',
      keepRecentHint: 'How many of the newest captures stay on disk. 0 keeps everything. Only files this plugin wrote are ever removed.',
      timeoutMs: 'Call budget (ms)',
      timeoutMsHint: 'How long one call may take, the wait for a change included. A single call can raise it further, up to 900000.',
      maxDimension: 'Largest side (px)',
      maxDimensionHint: 'A capture with a longer side is refused with its size named, not resized. Raise it to capture a display larger than this whole.',
      requireImageCapableModel: 'Require a model that can see',
      requireImageCapableModelHint: 'Refuse a capture when the calling model declares no image input, instead of returning a picture it cannot see.',
      deleteAfterCommit: 'Delete the PNG after commit',
      deleteAfterCommitHint: 'Delete the file once the image is in the attachment store. Off by default so the returned path stays re-readable.',
    };

    const ZH = {
      nav: '屏幕之眼',
      title: '屏幕之眼',
      intro: '给 agent 的屏幕视觉：截图落在哪里、保留多少张、一次调用可以花多久。改动对下一次截图生效，不需要重启。',
      changed: '已修改',
      reset: '重置',
      save: '保存',
      saving: '保存中…',
      discard: '放弃',
      unsaved: '有未保存的修改',
      saveFailed: 'Host 没有接受这次修改。你的编辑还在，改好再存一次。',
      invalid: '不是这个字段接受的值。',
      readOnly: '本次部署把偏好保存在内存里，无法写入。',
      locale: '语言',
      localeHint: '工具返回的「屏幕录制」引导文案所用语言。',
      outputDir: '截图目录',
      outputDirHint: '截下来的 PNG 存放在哪里。留空则使用系统图片文件夹下的「Screen Eye」子目录。',
      keepRecent: '保留截图数量',
      keepRecentHint: '磁盘上保留最新多少张截图。0 表示全部保留。只会删除本插件自己写出的文件。',
      timeoutMs: '调用预算（毫秒）',
      timeoutMsHint: '单次调用最长可以花多久，包含等待画面变化的时间。单次调用还能在此基础上再调高，上限 900000。',
      maxDimension: '最大边长（像素）',
      maxDimensionHint: '超过这个边长的截图会被拒绝并报出真实尺寸，而不是缩放到上限。要整屏截取更大的显示器，就把这里调高。',
      requireImageCapableModel: '要求模型支持图片输入',
      requireImageCapableModelHint: '当调用方模型未声明图片输入时直接拒绝，而不是返回一张它看不见的图。',
      deleteAfterCommit: '提交后删除 PNG',
      deleteAfterCommitHint: '图片进入附件存储后删除本地文件。默认关闭，以便返回的路径仍可再次读取。',
    };

    /**
     * Parse a whole number inside a range, or refuse the draft.
     * @param text - the draft.
     * @param min - smallest accepted value.
     * @param max - largest accepted value.
     * @returns the write, or undefined when the text is not a value this field takes.
     */
    function parseInteger(text, min, max) {
      if (!/^-?\d+$/u.test(text)) return undefined;
      const value = Number(text);
      if (!Number.isSafeInteger(value) || value < min || value > max) return undefined;
      return { kind: 'set', value };
    }

    /**
     * The fields this page exposes, in the order it draws them.
     *
     * `format` renders the stored value as draft text and `parse` turns draft
     * text back into a write, so those two are the only places that know a
     * field's type. An empty draft is always a clear — it drops the user layer
     * so the field re-inherits the mount entry — which is what a user expects
     * from emptying a text box, and it is why `parse` is never asked about ''.
     */
    const FIELDS = [
      {
        field: 'locale',
        label: 'locale',
        hint: 'localeHint',
        kind: 'enum',
        options: ['en', 'zh'],
        format: (value) => (value === undefined ? '' : String(value)),
        parse: (text) => ({ kind: 'set', value: text }),
      },
      {
        field: 'outputDir',
        label: 'outputDir',
        hint: 'outputDirHint',
        kind: 'text',
        format: (value) => (value === undefined ? '' : String(value)),
        parse: (text) => ({ kind: 'set', value: text }),
      },
      {
        field: 'keepRecent',
        label: 'keepRecent',
        hint: 'keepRecentHint',
        kind: 'integer',
        format: (value) => (value === undefined ? '' : String(value)),
        parse: (text) => parseInteger(text, 0, Number.MAX_SAFE_INTEGER),
      },
      {
        field: 'timeoutMs',
        label: 'timeoutMs',
        hint: 'timeoutMsHint',
        kind: 'integer',
        format: (value) => (value === undefined ? '' : String(value)),
        parse: (text) => parseInteger(text, 1000, 900000),
      },
      {
        field: 'maxDimension',
        label: 'maxDimension',
        hint: 'maxDimensionHint',
        kind: 'integer',
        format: (value) => (value === undefined ? '' : String(value)),
        parse: (text) => parseInteger(text, 1, Number.MAX_SAFE_INTEGER),
      },
      {
        field: 'requireImageCapableModel',
        label: 'requireImageCapableModel',
        hint: 'requireImageCapableModelHint',
        kind: 'boolean',
        // A boolean's draft text is the stored value spelled out, so the same
        // empty-draft-clears rule applies to it as to everything else.
        format: (value) => (value === false ? 'false' : 'true'),
        parse: (text) => ({ kind: 'set', value: text === 'true' }),
      },
      {
        field: 'deleteAfterCommit',
        label: 'deleteAfterCommit',
        hint: 'deleteAfterCommitHint',
        kind: 'boolean',
        format: (value) => (value === true ? 'true' : 'false'),
        parse: (text) => ({ kind: 'set', value: text === 'true' }),
      },
    ];

    /** The page's own styles: the host's tokens and measurements, our class names. */
    const CSS = `
.screye-section{max-width:760px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:12px;display:flex}
.screye-title{margin:0;font-size:17px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}
.screye-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.screye-fields{flex-direction:column;display:flex}
.screye-field{flex-direction:column;gap:6px;padding:14px 0;display:flex}
.screye-field+.screye-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.screye-fieldHead{align-items:center;gap:8px;display:flex}
.screye-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.screye-badges{align-items:center;gap:8px;display:inline-flex}
.screye-badge{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.screye-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.screye-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.screye-input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}
.screye-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.screye-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.screye-inputInvalid{border-color:var(--dsw-alias-label-error)}
.screye-invalid{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}
.screye-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.screye-checkRow{align-items:center;gap:10px;display:flex}
.screye-check{width:16px;height:16px;flex:none;margin:0;accent-color:var(--dsw-alias-brand-primary)}
.screye-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.screye-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.screye-pending{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;margin-right:auto}
.screye-discard,.screye-save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.screye-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.screye-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.screye-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.screye-discard:disabled,.screye-save:disabled{opacity:.4;cursor:default}
.screye-readOnly{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
/* The nav row: the shell gives an unrecognised section its generic gear, and
   offers no icon field. Hide that glyph and draw an eye in the same box, as a
   mask so it inherits the row's own colour in every state. */
[${NAV_MARKER}] > svg:first-child{display:none}
[${NAV_MARKER}]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("${EYE_SVG}") center / contain no-repeat;mask:url("${EYE_SVG}") center / contain no-repeat}
`;

    /** Inject the stylesheet once per document. */
    function ensureStyles() {
      if (document.getElementById('dsh-screen-eye-styles') !== null) return;
      const style = document.createElement('style');
      style.id = 'dsh-screen-eye-styles';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /**
     * Mark this plugin's own row in the settings navigation.
     *
     * The contract projects no id onto the row and no icon onto the section, so
     * the row is identified by the label this plugin itself registered — the one
     * thing about it that is ours. Re-run on DOM changes because the dialog
     * mounts and unmounts, and because a language switch relabels every row.
     *
     * @param labels - the label texts this section can appear under.
     * @returns a disposer that stops observing and removes the marker.
     */
    function registerNavIcon(labels) {
      const mark = () => {
        for (const button of document.querySelectorAll('nav button')) {
          const text = button.textContent?.trim() ?? '';
          if (labels.includes(text)) button.setAttribute(NAV_MARKER, '');
          else button.removeAttribute(NAV_MARKER);
        }
      };
      // The observer sees every mutation in the document, and a streaming
      // conversation mutates constantly: coalescing to one pass per frame keeps
      // a permanent observer from costing a query per keystroke of output.
      let scheduled = false;
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        const run = () => { scheduled = false; mark(); };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 16);
      };

      mark();
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return () => {
        observer.disconnect();
        for (const marked of document.querySelectorAll(`[${NAV_MARKER}]`)) marked.removeAttribute(NAV_MARKER);
      };
    }

    /**
     * Subscribe to one service face through React's store contract.
     *
     * The faces are class instances whose methods read `this`, so they are
     * called through closures rather than passed as bare references.
     *
     * @param face - an object with `subscribe` and `getSnapshot`.
     * @returns the current snapshot, re-rendering on change.
     */
    function useFace(face) {
      const subscribe = React.useCallback((listener) => face.subscribe(listener), [face]);
      const getSnapshot = React.useCallback(() => face.getSnapshot(), [face]);
      return React.useSyncExternalStore(subscribe, getSnapshot);
    }

    /**
     * The settings page.
     *
     * Holds the staged drafts and writes them on save; everything else is read
     * from the scope, which is the durable document's view. This state is only
     * what has not been written yet.
     *
     * @param props - `scope` (the bound settings scope), `locale` and `t`.
     * @returns the page, or null while the namespace is not served.
     */
    function ScreenEyeSection(props) {
      const { scope, locale, t } = props;
      const snapshot = useFace(scope);
      const [drafts, setDrafts] = React.useState({});
      const [saving, setSaving] = React.useState(false);
      const [failed, setFailed] = React.useState(false);

      // The language can change while the page is open, and the copy below is
      // read through the locale face rather than captured, so switching is one
      // more render and not a stale page.
      if (locale !== undefined) useFace(locale);

      // A namespace this deployment does not serve leaves no trace, rather than
      // a page of controls that could never save.
      if (snapshot.status !== 'ready') return null;

      const section = snapshot.value ?? {};
      const userLayer = snapshot.user ?? {};
      const writable = snapshot.writable === true;

      const specFor = (field) => FIELDS.find((candidate) => candidate.field === field);
      const draftFor = (spec) => (Object.hasOwn(drafts, spec.field)
        ? drafts[spec.field]
        : spec.format(section[spec.field]));

      const decided = FIELDS.filter((spec) => Object.hasOwn(drafts, spec.field));
      const invalid = decided.some((spec) => {
        const text = drafts[spec.field];
        return text !== '' && spec.parse(text) === undefined;
      });
      const dirty = decided.some((spec) => drafts[spec.field] !== spec.format(section[spec.field]));

      const edit = (field, text) => {
        setFailed(false);
        setDrafts((current) => ({ ...current, [field]: text }));
      };

      const save = async () => {
        if (saving || invalid || !dirty) return;
        setSaving(true);
        setFailed(false);
        try {
          for (const field of Object.keys(drafts)) {
            const spec = specFor(field);
            if (spec === undefined) continue;
            const text = drafts[field];
            if (text === '') {
              // An empty draft re-inherits: the mount entry first, the schema
              // after it. Nothing is written when there is nothing to clear.
              if (Object.hasOwn(userLayer, field)) await scope.unset(field);
              continue;
            }
            const write = spec.parse(text);
            if (write === undefined) continue;
            await scope.set(field, write.value);
          }
          setDrafts({});
        } catch {
          // The host is the only authority on what it accepted, so a refusal
          // keeps the drafts: the user corrects the value instead of retyping.
          setFailed(true);
        } finally {
          setSaving(false);
        }
      };

      const rows = FIELDS.map((spec) => h(Field, {
        key: spec.field,
        spec,
        label: t(spec.label),
        hint: t(spec.hint),
        text: draftFor(spec),
        overridden: Object.hasOwn(userLayer, spec.field),
        invalid: Object.hasOwn(drafts, spec.field)
          && drafts[spec.field] !== ''
          && spec.parse(drafts[spec.field]) === undefined,
        disabled: !writable || saving,
        t,
        onEdit: (text) => edit(spec.field, text),
        // A reset is not an edit being composed: it is "forget my override",
        // one gesture and one document mutation, after which the control shows
        // what the field actually resolves to.
        onReset: () => {
          setFailed(false);
          setDrafts((current) => {
            const next = { ...current };
            delete next[spec.field];
            return next;
          });
          Promise.resolve(scope.unset(spec.field)).catch(() => setFailed(true));
        },
      }));

      return h('div', { className: 'screye-section' }, [
        h('h2', { key: 'title', className: 'screye-title' }, t('title')),
        h('p', { key: 'intro', className: 'screye-intro' }, t('intro')),
        h('div', { key: 'fields', className: 'screye-fields' }, rows),
        writable ? null : h('p', { key: 'readonly', className: 'screye-readOnly' }, t('readOnly')),
        h('div', { key: 'footer', className: 'screye-footer' }, [
          failed ? h('p', { key: 'failed', className: 'screye-failed' }, t('saveFailed')) : null,
          !failed && dirty
            ? h('p', { key: 'pending', className: 'screye-pending' }, t('unsaved'))
            : null,
          h('button', {
            key: 'discard',
            type: 'button',
            className: 'screye-discard',
            disabled: !dirty || saving,
            onClick: () => { setDrafts({}); setFailed(false); },
          }, t('discard')),
          h('button', {
            key: 'save',
            type: 'button',
            className: 'screye-save',
            disabled: !writable || !dirty || invalid || saving,
            onClick: () => { save(); },
          }, saving ? t('saving') : t('save')),
        ]),
      ]);
    }

    /**
     * One field row: label, the changed badge and reset, the control, and
     * either the hint or the refusal.
     *
     * @param props - the field spec plus its current state and callbacks.
     * @returns the row.
     */
    function Field(props) {
      const { spec, label, hint, text, overridden, invalid, disabled, t, onEdit, onReset } = props;

      const control = spec.kind === 'boolean'
        ? h('input', {
          type: 'checkbox',
          className: 'screye-check',
          checked: text === 'true',
          disabled,
          'aria-label': label,
          onChange: (event) => onEdit(event.target.checked ? 'true' : 'false'),
        })
        : spec.kind === 'enum'
          ? h('select', {
            className: invalid ? 'screye-input screye-inputInvalid' : 'screye-input',
            value: text,
            disabled,
            'aria-label': label,
            onChange: (event) => onEdit(event.target.value),
          }, spec.options.map((option) => h('option', { key: option, value: option }, option)))
          : h('input', {
            type: spec.kind === 'integer' ? 'number' : 'text',
            className: invalid ? 'screye-input screye-inputInvalid' : 'screye-input',
            value: text,
            disabled,
            'aria-label': label,
            onChange: (event) => onEdit(event.target.value),
          });

      return h('div', { className: 'screye-field' }, [
        h('div', { key: 'head', className: 'screye-fieldHead' }, [
          h('span', { key: 'label', className: 'screye-label' }, label),
          overridden
            ? h('span', { key: 'badges', className: 'screye-badges' },
              [h('span', { key: 'badge', className: 'screye-badge' }, t('changed'))])
            : null,
          overridden
            ? h('button', {
              key: 'reset',
              type: 'button',
              className: 'screye-reset',
              disabled,
              onClick: () => onReset(),
            }, t('reset'))
            : null,
        ]),
        h('div', { key: 'control', className: 'screye-checkRow' }, [control]),
        h('p', { key: 'hint', className: invalid ? 'screye-invalid' : 'screye-hint' },
          invalid ? t('invalid') : hint),
      ]);
    }

    /**
     * Mount the section.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS);
      // The stylesheet carries the nav glyph as well as the page's own layout,
      // and the nav row exists whether or not the page is open — so it goes in
      // at mount rather than from the page's first render.
      ctx.effect(() => { ensureStyles(); }, 'screen-eye: stylesheet');
      // Dictionary registration is an effect of this plugin's fiber, so the
      // copy goes away with the page rather than outliving it.
      ctx.effect(() => {
        const offEn = ctx.locale.register(LOCALE_NS, 'en', EN);
        const offZh = ctx.locale.register(LOCALE_NS, 'zh', ZH);
        return () => { offEn(); offZh(); };
      }, 'screen-eye: page dictionaries');

      ctx.effect(
        () => registerNavIcon([EN.nav, ZH.nav]),
        'screen-eye: settings navigation glyph',
      );

      // The settings transport: without it there is no document to read or
      // write, and a page that could never save would be a control the user
      // cannot act on.
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE });
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NAMESPACE,
        // After everything the harness ships (general 0, models 10, plugins 15,
        // agent presets 20): a plugin's page does not push the built-in ones.
        order: 25,
        label: () => t('nav'),
        locale: LOCALE_NS,
        inject: () => ({ scope, locale: ctx.locale, t }),
      }, ScreenEyeSection));
    }

    return {
      name: 'dsh-screen-eye',
      inject: ['slots', 'locale', 'settingsScope'],
      apply,
    };
  },
});
