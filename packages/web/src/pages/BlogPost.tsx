import React, { useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { posts } from '../blog';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export default function BlogPost(): React.ReactElement {
  const { slug } = useParams<{ slug: string }>();
  const post = posts.find((p) => p.slug === slug);

  useEffect(() => {
    if (post) {
      document.title = `${post.title} — BasedAgents`;
      const meta = document.querySelector('meta[name="description"]');
      if (meta) meta.setAttribute('content', post.description);
    }
  }, [post]);

  if (!post) {
    return (
      <div className="container" style={{ paddingTop: 64, paddingBottom: 64, textAlign: 'center' }}>
        <h1>Post not found</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: 12 }}>
          <Link to="/blog">← Back to blog</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="container" style={{ paddingTop: 48, paddingBottom: 64 }}>
      <Link
        to="/blog"
        style={{ color: 'var(--text-secondary)', fontSize: 14, display: 'inline-block', marginBottom: 32 }}
      >
        ← Back to blog
      </Link>

      <article>
        {/* Header */}
        <header style={{ marginBottom: 48 }}>
          <h1 style={{ fontSize: 36, lineHeight: 1.2, marginBottom: 8 }}>{post.title}</h1>
          {post.subtitle && (
            <p style={{ color: 'var(--accent)', fontSize: 18, fontWeight: 500, marginBottom: 16 }}>
              {post.subtitle}
            </p>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', color: 'var(--text-secondary)', fontSize: 14 }}>
            <span>
              {post.author}
              {post.authorRole && (
                <span style={{ color: 'var(--text-tertiary)' }}> · {post.authorRole}</span>
              )}
            </span>
            <span>{formatDate(post.publishedAt)}</span>
            <span>{post.readingTime} min read</span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {post.tags.map((tag) => (
              <span
                key={tag}
                style={{
                  background: 'var(--accent-muted)',
                  color: 'var(--accent)',
                  fontSize: 12,
                  padding: '2px 10px',
                  borderRadius: 12,
                  fontWeight: 500,
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        </header>

        {/* Content */}
        <div className="blog-content" style={{ maxWidth: 720, lineHeight: 1.8 }}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              table: ({ children }) => (
                <div style={{ overflowX: 'auto', marginBottom: 20 }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: 14, width: '100%' }}>{children}</table>
                </div>
              ),
              th: ({ children }) => (
                <th style={{ border: '1px solid var(--border)', padding: '8px 10px', textAlign: 'left', whiteSpace: 'nowrap' }}>{children}</th>
              ),
              td: ({ children }) => (
                <td style={{ border: '1px solid var(--border)', padding: '8px 10px', color: 'var(--text-secondary)' }}>{children}</td>
              ),
              h2: ({ children }) => (
                <h2 style={{ fontSize: 24, marginTop: 40, marginBottom: 16 }}>{children}</h2>
              ),
              h3: ({ children }) => (
                <h3 style={{ fontSize: 20, marginTop: 32, marginBottom: 12 }}>{children}</h3>
              ),
              p: ({ children }) => (
                <p style={{ color: 'var(--text-secondary)', marginBottom: 20, fontSize: 16 }}>{children}</p>
              ),
              ul: ({ children }) => (
                <ul style={{ color: 'var(--text-secondary)', marginBottom: 20, paddingLeft: 24, fontSize: 16 }}>{children}</ul>
              ),
              ol: ({ children }) => (
                <ol style={{ color: 'var(--text-secondary)', marginBottom: 20, paddingLeft: 24, fontSize: 16 }}>{children}</ol>
              ),
              li: ({ children }) => (
                <li style={{ marginBottom: 8 }}>{children}</li>
              ),
              strong: ({ children }) => (
                <strong style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{children}</strong>
              ),
              code: ({ className, children }) => {
                const isBlock = className?.includes('language-');
                if (isBlock) {
                  return (
                    <code
                      style={{
                        display: 'block',
                        background: 'var(--bg-tertiary)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: 20,
                        fontFamily: 'var(--font-mono)',
                        fontSize: 14,
                        lineHeight: 1.6,
                        overflowX: 'auto',
                        marginBottom: 20,
                      }}
                    >
                      {children}
                    </code>
                  );
                }
                return (
                  <code
                    style={{
                      background: 'var(--bg-tertiary)',
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.9em',
                    }}
                  >
                    {children}
                  </code>
                );
              },
              pre: ({ children }) => (
                <pre style={{ marginBottom: 20 }}>{children}</pre>
              ),
              blockquote: ({ children }) => (
                <blockquote
                  style={{
                    borderLeft: '3px solid var(--accent)',
                    paddingLeft: 20,
                    marginBottom: 20,
                    color: 'var(--text-secondary)',
                    fontStyle: 'italic',
                  }}
                >
                  {children}
                </blockquote>
              ),
              img: ({ src, alt }) => (
                <img
                  src={src}
                  alt={alt ?? ''}
                  loading="lazy"
                  style={{ width: '100%', borderRadius: 12, border: '1px solid var(--border)', margin: '8px 0 20px' }}
                />
              ),
              a: ({ href, children }) => (
                <a href={href} style={{ color: 'var(--accent)' }}>
                  {children}
                </a>
              ),
            }}
          >
            {post.content}
          </Markdown>
        </div>

        {/* CTA */}
        <div
          style={{
            marginTop: 64,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 32,
            maxWidth: 720,
          }}
        >
          <h3 style={{ marginBottom: 8 }}>Ready to register your agent?</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 15, marginBottom: 16 }}>
            Get your agent a verifiable identity in seconds.
          </p>
          <code
            style={{
              display: 'block',
              background: 'var(--bg-tertiary)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '12px 16px',
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
              color: 'var(--text-primary)',
              marginBottom: 16,
            }}
          >
            npx basedagents register
          </code>
          <Link
            to="/register"
            style={{
              display: 'inline-block',
              background: 'var(--accent)',
              color: '#fff',
              padding: '10px 20px',
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 15,
              textDecoration: 'none',
            }}
          >
            Register Agent →
          </Link>
        </div>
      </article>
    </div>
  );
}
