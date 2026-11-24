'use client';
/**
 * Global keymap (UI-SPEC §14) and the matching ⌘K commands, so every global action has a key and a
 * palette entry. List keys live with each list (useListKeys).
 *
 * Frame keys (v2): ⌘J toggles the Assistant, Esc closes the panel (focus returns to the opener),
 * `]` toggles the panel, `[` collapses the sidebar. Go-to chords and commands follow the persona's destinations
 * (navDestinationsFor, D-55: a destination whose feature is inactive has neither).
 */
import { useKeyBinding } from '@/client/keyboard/KeyboardProvider';
import { useCommands, type Command } from '@/client/keyboard/commands';
import { usePersona } from '@/client/persona';
import { toggleChatFocus } from '@/components/chat';
import { navDestinationsFor } from './nav';
import { navigate } from './router';
import { usePanelInternals, useRightPanel } from './panel';
import { usePrefs, type ColorScheme, type TextSize } from './prefs';
import { useShell } from './ShellContext';
import { openReadme } from '@/guide/Readme';
import { useGuideSettings } from '@/guide/useGuide';
import { useOpenFeedback } from './FeedbackButton';

const SCHEME_LABEL: Record<ColorScheme, string> = { dark: 'Dark theme', light: 'Light theme', system: 'Match the system theme' };
const TEXT_LABEL: Record<TextSize, string> = { sm: 'Small text', md: 'Default text size', lg: 'Large text' };

export function GlobalKeys() {
  // Every Go-to marks the navigation pending first, so #cc-main shows the destination's skeleton at once.
  const shell = useShell();
  const panel = useRightPanel();
  const internals = usePanelInternals();
  const prefs = usePrefs();
  const openFeedback = useOpenFeedback();
  const guide = useGuideSettings();
  const assistantShowing = internals.visible && panel.tab === 'assistant';
  const destinations = navDestinationsFor(usePersona());

  // On /assistant the page is the assistant: ⌘J focuses its composer (and back), never the panel.
  const toggleAssistant = () => (internals.assistantHere ? toggleChatFocus() : assistantShowing ? panel.toggleAssistant() : shell.focusChat());

  useKeyBinding('mod+k', () => shell.setPaletteOpen(!shell.paletteOpen), { allowInInput: true, description: 'Command palette' });
  useKeyBinding('mod+j', toggleAssistant, { allowInInput: true, description: 'Assistant' });
  useKeyBinding('escape', () => internals.closeAndRestore(), { enabled: internals.visible, description: 'Close the panel' });
  useKeyBinding(']', () => internals.togglePanel(), { description: 'Toggle the panel' });
  useKeyBinding('[', () => shell.toggleSidebar(), { description: 'Collapse the sidebar' });
  useKeyBinding('c', () => shell.setUtility('capture'), { description: 'Capture' });
  useKeyBinding('?', () => shell.setCheatOpen(true), { description: 'Shortcuts' });
  useKeyBinding('mod+,', () => navigate('/settings'), { allowInInput: true, description: 'Settings' });
  useKeyBinding(
    destinations.map((n) => n.chord),
    (e) => {
      const hit = destinations.find((n) => n.chord.endsWith(` ${e.key.toLowerCase()}`));
      if (!hit) return false;
      navigate(hit.href);
    },
    { description: 'Go to' },
  );

  const commands: Command[] = [
    ...destinations.map((n, i) => ({
      id: `go:${n.href}`,
      title: `Go to ${n.label}`,
      group: 'Go to',
      shortcut: n.chord,
      order: i,
      icon: { set: 'utility' as const, name: n.icon },
      keywords: [n.label, n.href],
      run: () => navigate(n.href),
    })),
    { id: 'go:/settings', title: 'Go to Settings', group: 'Go to', shortcut: 'mod+,', order: 99, icon: { set: 'utility', name: 'settings' }, keywords: ['preferences', 'policy'], run: () => navigate('/settings') },
    { id: 'create:capture', title: 'Capture a to-do', group: 'Create', shortcut: 'c', icon: { set: 'utility', name: 'record_create' }, keywords: ['new', 'add', 'task', 'note', 'quick'], run: () => shell.setUtility('capture') },
    { id: 'create:log', title: 'Log time', group: 'Create', icon: { set: 'utility', name: 'clock' }, keywords: ['activity', 'timesheet'], run: () => navigate('/activity') },
    { id: 'create:tool', title: 'Run a tool…', group: 'Create', icon: { set: 'utility', name: 'apps' }, keywords: ['tools', 'launcher', 'adapter'], run: () => navigate('/agents/tools') },
    {
      id: 'view:assistant',
      title: assistantShowing ? 'Close the assistant' : 'Open the assistant',
      group: 'View',
      shortcut: 'mod+j',
      icon: { set: 'utility', name: 'sparkles' },
      keywords: ['chat', 'ask', 'claude', 'panel'],
      run: toggleAssistant,
    },
    { id: 'view:panel', title: internals.visible ? 'Close the panel' : 'Open the panel', group: 'View', shortcut: ']', icon: { set: 'utility', name: 'toggle_panel_right' }, keywords: ['details', 'right', 'dock'], run: () => internals.togglePanel() },
    {
      id: 'view:sidebar',
      title: shell.sidebarCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar',
      group: 'View',
      shortcut: '[',
      icon: { set: 'utility', name: 'toggle_panel_left' },
      keywords: ['nav', 'navigation', 'rail'],
      run: () => shell.toggleSidebar(),
    },
    { id: 'view:sources', title: 'Sources and sending', group: 'View', icon: { set: 'utility', name: 'sync' }, keywords: ['catch up', 'connectors', 'dry run', 'live send', 'health'], run: () => shell.setUtility('catchup') },
    { id: 'view:since', title: 'Since you left', group: 'View', icon: { set: 'utility', name: 'recent' }, keywords: ['away', 'digest', 'changed'], run: () => shell.setUtility('since') },
    { id: 'view:spend', title: 'AI spend today', group: 'View', icon: { set: 'utility', name: 'money' }, keywords: ['budget', 'cost'], run: () => shell.setUtility('spend') },
    ...(['dark', 'light', 'system'] as const)
      .filter((s) => s !== prefs.scheme)
      .map((s) => ({ id: `view:scheme:${s}`, title: SCHEME_LABEL[s], group: 'View', icon: { set: 'utility' as const, name: 'color_swatch' }, keywords: ['theme', 'dark mode', 'light mode', 'appearance'], run: () => prefs.set({ scheme: s }) })),
    ...(['sm', 'md', 'lg'] as const)
      .filter((t) => t !== prefs.textSize)
      .map((t) => ({ id: `view:text:${t}`, title: TEXT_LABEL[t], group: 'View', icon: { set: 'utility' as const, name: 'text' }, keywords: ['font', 'size', 'zoom', 'bigger', 'smaller'], run: () => prefs.set({ textSize: t }) })),
    {
      id: 'view:density',
      title: prefs.density === 'compact' ? 'Comfortable density' : 'Compact density',
      group: 'View',
      icon: { set: 'utility', name: 'rows' },
      keywords: ['density', 'spacing', 'rows'],
      run: () => prefs.set({ density: prefs.density === 'compact' ? 'comfortable' : 'compact' }),
    },
    { id: 'help:shortcuts', title: 'Keyboard shortcuts', group: 'Help', shortcut: '?', icon: { set: 'utility', name: 'shortcuts' }, keywords: ['keys', 'cheat sheet', 'help'], run: () => shell.setCheatOpen(true) },
    { id: 'help:about', title: 'About Command Center (version, changelog)', group: 'Help', icon: { set: 'utility', name: 'info' }, keywords: ['version', 'about', 'changelog', 'update', 'sha', 'build'], run: () => navigate('/settings?section=about') },
    { id: 'help:feedback', title: 'Report a bug / idea', group: 'Help', icon: { set: 'utility', name: 'bug' }, keywords: ['feedback', 'bug', 'idea', 'enhancement', 'report', 'issue', 'problem'], run: () => openFeedback() },
    { id: 'help:readme', title: 'Read the README', group: 'Help', icon: { set: 'utility', name: 'knowledge_base' }, keywords: ['readme', 'setup', 'install', 'docs', 'help', 'update'], run: () => openReadme() },
    { id: 'help:getting-started', title: guide.guide?.checklistDismissed ? 'Show the Getting started checklist' : 'Getting started checklist', group: 'Help', icon: { set: 'utility', name: 'task' }, keywords: ['onboarding', 'checklist', 'tips', 'guide', 'tour'], run: () => (guide.guide?.checklistDismissed ? guide.dismissChecklist(false) : document.querySelector<HTMLElement>('[data-testid="getting-started"]')?.click()) },
  ];
  useCommands(commands);
  return null;
}
