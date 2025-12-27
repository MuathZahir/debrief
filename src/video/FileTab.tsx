import React from 'react';
import { getTheme, getScale } from './themes/editor';

interface FileTabProps {
  path: string;
  theme: 'dark' | 'light';
  resolution?: string;
}

/**
 * VS Code-style file tab header
 * Shows the filename prominently with the full path below
 */
export const FileTab: React.FC<FileTabProps> = ({
  path,
  theme,
  resolution = '1080p',
}) => {
  const editorTheme = getTheme(theme);
  const scale = getScale(resolution);

  // Extract filename from path
  const filename = path.split('/').pop() ?? path;

  // Get file extension for icon styling
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';

  // Scale font sizes based on resolution
  const filenameFontSize = Math.round(scale.fontSize * 0.75);
  const pathFontSize = Math.round(scale.fontSize * 0.5);
  const tabHeight = Math.round(scale.lineHeight * 1.5);
  const iconSize = Math.round(scale.fontSize * 0.7);

  return (
    <div
      style={{
        backgroundColor: editorTheme.tabBackground,
        borderBottom: `1px solid ${editorTheme.tabBorder}`,
        display: 'flex',
        alignItems: 'center',
        height: `${tabHeight}px`,
        paddingLeft: `${scale.padding}px`,
        paddingRight: `${scale.padding}px`,
      }}
    >
      {/* File icon */}
      <div
        style={{
          width: `${iconSize}px`,
          height: `${iconSize}px`,
          marginRight: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <FileIcon extension={extension} size={iconSize} theme={theme} />
      </div>

      {/* Active tab */}
      <div
        style={{
          backgroundColor: editorTheme.tabActiveBackground,
          padding: `8px 16px`,
          borderTop: `2px solid ${editorTheme.highlightBorder}`,
          marginTop: '-1px',
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
        }}
      >
        <span
          style={{
            color: editorTheme.tabTextActive,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: `${filenameFontSize}px`,
            fontWeight: 500,
          }}
        >
          {filename}
        </span>
        <span
          style={{
            color: editorTheme.tabText,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: `${pathFontSize}px`,
          }}
        >
          {path}
        </span>
      </div>
    </div>
  );
};

/**
 * Simple file icon based on extension
 */
const FileIcon: React.FC<{
  extension: string;
  size: number;
  theme: 'dark' | 'light';
}> = ({ extension, size, theme }) => {
  // Color based on file type
  const getColor = (): string => {
    const colors: Record<string, string> = {
      ts: '#3178c6',
      tsx: '#3178c6',
      js: '#f7df1e',
      jsx: '#61dafb',
      py: '#3776ab',
      rs: '#dea584',
      go: '#00add8',
      java: '#ed8b00',
      rb: '#cc342d',
      php: '#777bb4',
      css: '#1572b6',
      html: '#e34f26',
      json: '#292929',
      md: '#083fa1',
    };
    return colors[extension] ?? (theme === 'dark' ? '#858585' : '#666666');
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M14 2H6C4.9 2 4 2.9 4 4V20C4 21.1 4.9 22 6 22H18C19.1 22 20 21.1 20 20V8L14 2Z"
        fill={getColor()}
        fillOpacity="0.2"
        stroke={getColor()}
        strokeWidth="1.5"
      />
      <path
        d="M14 2V8H20"
        stroke={getColor()}
        strokeWidth="1.5"
      />
    </svg>
  );
};
