import React from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus, vs } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { getTheme, getScale, type EditorTheme, type ScaleConfig } from './themes/editor';

interface CodeViewProps {
  code: string;
  language: string;
  highlightedLines: [number, number] | null;
  theme: 'dark' | 'light';
  resolution?: string;
}

/**
 * Code display component with syntax highlighting and line highlights
 * Uses react-syntax-highlighter for consistent line-by-line rendering
 */
export const CodeView: React.FC<CodeViewProps> = ({
  code,
  language,
  highlightedLines,
  theme,
  resolution = '1080p',
}) => {
  const editorTheme = getTheme(theme);
  const scale = getScale(resolution);
  const syntaxTheme = theme === 'dark' ? vscDarkPlus : vs;

  // Create line props function to apply highlight styling
  const lineProps = (lineNumber: number): React.HTMLProps<HTMLElement> => {
    const isHighlighted =
      highlightedLines &&
      lineNumber >= highlightedLines[0] &&
      lineNumber <= highlightedLines[1];

    return {
      style: {
        display: 'block',
        width: '100%',
        backgroundColor: isHighlighted ? editorTheme.highlightBackground : 'transparent',
        borderLeft: isHighlighted ? `4px solid ${editorTheme.highlightBorder}` : '4px solid transparent',
        paddingLeft: '12px',
        marginLeft: '-16px',
        transition: 'none', // No CSS transitions - let Remotion handle animations
      },
    };
  };

  // Custom style overrides for the syntax highlighter
  const customStyle: React.CSSProperties = {
    margin: 0,
    padding: `${scale.padding}px`,
    backgroundColor: editorTheme.background,
    fontSize: `${scale.fontSize}px`,
    lineHeight: `${scale.lineHeight}px`,
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Consolas', monospace",
    overflow: 'hidden',
    height: '100%',
    boxSizing: 'border-box',
  };

  // Line number style
  const lineNumberStyle: React.CSSProperties = {
    minWidth: `${scale.lineNumberWidth}px`,
    paddingRight: '16px',
    textAlign: 'right',
    color: editorTheme.lineNumbers,
    userSelect: 'none',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Consolas', monospace",
  };

  // Map language names to Prism language identifiers
  const prismLanguage = mapLanguage(language);

  return (
    <div
      style={{
        flex: 1,
        backgroundColor: editorTheme.background,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <SyntaxHighlighter
        language={prismLanguage}
        style={syntaxTheme}
        customStyle={customStyle}
        showLineNumbers
        lineNumberStyle={lineNumberStyle}
        wrapLines
        lineProps={lineProps}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
};

/**
 * Map common language names to Prism language identifiers
 */
function mapLanguage(language: string): string {
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    go: 'go',
    java: 'java',
    cpp: 'cpp',
    c: 'c',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    sh: 'bash',
    bash: 'bash',
    shell: 'bash',
    sql: 'sql',
    html: 'html',
    css: 'css',
    scss: 'scss',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    markdown: 'markdown',
  };

  return languageMap[language.toLowerCase()] ?? language.toLowerCase();
}
