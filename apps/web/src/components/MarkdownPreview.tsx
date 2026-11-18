import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
  path: string;
  pagePath: string;
  basePath: string;
  branch: string;
}

export function MarkdownBody({
  content,
  path,
  pagePath,
  basePath,
  branch,
}: MarkdownContentProps) {
  const fileHref = (target: string) => {
    const { path: targetPath, suffix } = splitUrlSuffix(target);
    const resolved = resolveRepositoryPath(path, targetPath);
    if (!resolved) return "";
    const parent = resolved.split("/").slice(0, -1).join("/");
    const query = new URLSearchParams({
      branch,
      view: "tree",
      path: parent,
      file: resolved,
    });
    return `${pagePath}?${query.toString()}${suffix}`;
  };

  const imageSrc = (target: string) => {
    const { path: targetPath } = splitUrlSuffix(target);
    const resolved = resolveRepositoryPath(path, targetPath);
    if (!resolved) return "";
    return `${basePath}/blob?${new URLSearchParams({
      branch,
      path: resolved,
      inline: "true",
    }).toString()}`;
  };

  const components: Components = {
    a({ href, children, node: _node, ...props }) {
      if (!href) return <>{children}</>;
      if (isExternalUrl(href) || href.startsWith("#")) {
        return (
          <a
            {...props}
            href={href}
            rel={isExternalUrl(href) ? "noreferrer noopener" : undefined}
            target={isExternalUrl(href) ? "_blank" : undefined}
          >
            {children}
          </a>
        );
      }
      const resolved = fileHref(href);
      return resolved ? (
        <a {...props} href={resolved}>
          {children}
        </a>
      ) : (
        <>{children}</>
      );
    },
    img({ src, alt, node: _node, ...props }) {
      if (typeof src !== "string" || !src) return null;
      if (isExternalUrl(src)) {
        return <img {...props} src={src} alt={alt ?? ""} loading="lazy" />;
      }
      const resolved = imageSrc(src);
      return resolved ? (
        <img {...props} src={resolved} alt={alt ?? ""} loading="lazy" />
      ) : null;
    },
  };

  return (
    <div className="markdown-body">
      <ReactMarkdown
        components={components}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        remarkPlugins={[remarkGfm]}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function MarkdownPreview(props: MarkdownContentProps) {
  return (
    <section className="readme-preview" aria-label={basename(props.path)}>
      <div className="readme-preview-heading">
        <ReadmeIcon />
        <strong>{basename(props.path)}</strong>
      </div>
      <MarkdownBody {...props} />
    </section>
  );
}

export function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

function resolveRepositoryPath(sourcePath: string, target: string): string {
  const normalizedTarget = target.replace(/\\/g, "/");
  const base = normalizedTarget.startsWith("/")
    ? []
    : sourcePath.split("/").slice(0, -1);
  const segments = normalizedTarget.startsWith("/")
    ? normalizedTarget.slice(1).split("/")
    : normalizedTarget.split("/");

  for (const rawSegment of segments) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      segment = rawSegment;
    }
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (base.length === 0) return "";
      base.pop();
      continue;
    }
    base.push(segment);
  }
  return base.join("/");
}

function splitUrlSuffix(value: string): { path: string; suffix: string } {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const indexes = [queryIndex, hashIndex].filter((index) => index >= 0);
  const splitAt = indexes.length > 0 ? Math.min(...indexes) : value.length;
  return {
    path: value.slice(0, splitAt),
    suffix: value.slice(splitAt),
  };
}

function isExternalUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
}

function basename(value: string): string {
  return value.split("/").pop() ?? value;
}

function ReadmeIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5" />
      <path d="M9 12h6M9 16h6" />
    </svg>
  );
}
