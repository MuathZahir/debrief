/**
 * VS Code-inspired theme configuration for code videos
 */

export interface EditorTheme {
  name: string;
  background: string;
  foreground: string;
  lineNumbers: string;
  lineNumbersActive: string;
  highlightBackground: string;
  highlightBorder: string;
  tabBackground: string;
  tabActiveBackground: string;
  tabBorder: string;
  tabText: string;
  tabTextActive: string;
}

/**
 * Resolution-aware scaling configuration
 */
export interface ScaleConfig {
  fontSize: number;
  lineHeight: number;
  padding: number;
  lineNumberWidth: number;
}

export const SCALE_CONFIGS: Record<string, ScaleConfig> = {
  '720p': {
    fontSize: 18,
    lineHeight: 30,
    padding: 24,
    lineNumberWidth: 50,
  },
  '1080p': {
    fontSize: 24,
    lineHeight: 40,
    padding: 32,
    lineNumberWidth: 60,
  },
  '1440p': {
    fontSize: 28,
    lineHeight: 46,
    padding: 40,
    lineNumberWidth: 70,
  },
  '4k': {
    fontSize: 32,
    lineHeight: 52,
    padding: 48,
    lineNumberWidth: 80,
  },
};

export const vscodeDark: EditorTheme = {
  name: 'VS Code Dark+',
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  lineNumbers: '#858585',
  lineNumbersActive: '#c6c6c6',
  highlightBackground: 'rgba(255, 215, 0, 0.15)',
  highlightBorder: '#ffd700',
  tabBackground: '#252526',
  tabActiveBackground: '#1e1e1e',
  tabBorder: '#1e1e1e',
  tabText: '#969696',
  tabTextActive: '#ffffff',
};

export const vscodeLight: EditorTheme = {
  name: 'VS Code Light+',
  background: '#ffffff',
  foreground: '#000000',
  lineNumbers: '#237893',
  lineNumbersActive: '#0b216f',
  highlightBackground: 'rgba(255, 215, 0, 0.25)',
  highlightBorder: '#e6c200',
  tabBackground: '#ececec',
  tabActiveBackground: '#ffffff',
  tabBorder: '#f3f3f3',
  tabText: '#666666',
  tabTextActive: '#333333',
};

export function getTheme(themeName: 'dark' | 'light'): EditorTheme {
  return themeName === 'dark' ? vscodeDark : vscodeLight;
}

export function getScale(resolution: string): ScaleConfig {
  return SCALE_CONFIGS[resolution] ?? SCALE_CONFIGS['1080p'];
}
