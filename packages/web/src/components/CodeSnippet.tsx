import React, { useState } from 'react';

interface CodeSnippetProps {
  children: string;
  language?: string;
  terminal?: boolean;
  /** Called after a successful copy — e.g. a funnel ping. Never blocks the copy. */
  onCopy?: () => void;
}

export default function CodeSnippet({ children, language, terminal = false, onCopy }: CodeSnippetProps): React.ReactElement {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      try { onCopy?.(); } catch { /* telemetry must never break the copy */ }
    });
  };

  // Apply basic syntax highlighting
  const highlightLine = (line: string) => {
    const parts: React.ReactNode[] = [];
    let remaining = line;
    let key = 0;

    // Success markers
    if (remaining.includes('✓')) {
      const idx = remaining.indexOf('✓');
      if (idx > 0) parts.push(<span key={key++}>{remaining.slice(0, idx)}</span>);
      parts.push(<span key={key++} style={{ color: 'var(--status-active)' }}>✓</span>);
      remaining = remaining.slice(idx + 1);
    }

    // Error markers
    if (remaining.includes('✗')) {
      const idx = remaining.indexOf('✗');
      if (idx > 0) parts.push(<span key={key++}>{remaining.slice(0, idx)}</span>);
      parts.push(<span key={key++} style={{ color: 'var(--status-suspended)' }}>✗</span>);
      remaining = remaining.slice(idx + 1);
    }

    // Comments
    if (remaining.trimStart().startsWith('//') || remaining.trimStart().startsWith('#')) {
      parts.push(<span key={key++} style={{ color: 'var(--text-tertiary)' }}>{remaining}</span>);
      return parts;
    }

    // Dollar prompt
    if (terminal && remaining.trimStart().startsWith('$')) {
      const trimmed = remaining.trimStart();
      const indent = remaining.length - trimmed.length;
      parts.push(<span key={key++}>{remaining.slice(0, indent)}</span>);
      parts.push(<span key={key++} style={{ color: 'var(--text-tertiary)' }}>$</span>);
      parts.push(<span key={key++} style={{ color: 'var(--text-primary)' }}>{trimmed.slice(1)}</span>);
      return parts;
    }

    // Keyword highlighting for import/from/const/await/async
    const kwRegex = /\b(import|from|const|let|var|await|async|function|export|return)\b/g;
    let match;
    let lastIdx = 0;
    const kwParts: React.ReactNode[] = [];
    while ((match = kwRegex.exec(remaining)) !== null) {
      if (match.index > lastIdx) {
        kwParts.push(<span key={key++}>{remaining.slice(lastIdx, match.index)}</span>);
      }
      kwParts.push(<span key={key++} style={{ color: 'var(--accent)' }}>{match[0]}</span>);
      lastIdx = kwRegex.lastIndex;
    }
    if (kwParts.length > 0) {
      if (lastIdx < remaining.length) {
        kwParts.push(<span key={key++}>{remaining.slice(lastIdx)}</span>);
      }
      return [...parts, ...kwParts];
    }

    if (parts.length === 0) return [<span key={0}>{line}</span>];
    parts.push(<span key={key++}>{remaining}</span>);
    return parts;
  };

  const lines = children.split('\n');

  return (
    <div
      style={{
        position: 'relative',
        background: 'var(--bg-tertiary)',
        borderRadius: 8,
        padding: 20,
        maxHeight: 400,
        overflow: 'auto',
      }}
    >
      {/* Language label */}
      {language && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            left: 16,
            fontSize: 12,
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
            textTransform: 'lowercase',
          }}
        >
          {language}
        </div>
      )}

      {/* Copy button */}
      <button
        onClick={handleCopy}
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: 'none',
          border: 'none',
          color: 'var(--text-tertiary)',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
          fontSize: 14,
          padding: '4px 8px',
          borderRadius: 4,
          transition: 'color 150ms ease',
        }}
        onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-secondary)')}
        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
        title="Copy to clipboard"
      >
        {copied ? 'Copied!' : '⧉'}
      </button>

      <pre
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 14,
          lineHeight: 1.6,
          color: 'var(--text-secondary)',
          margin: language ? '16px 0 0' : 0,
          overflow: 'visible',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {lines.map((line, i) => (
          <div key={i}>{highlightLine(line)}</div>
        ))}
      </pre>
    </div>
  );
}
