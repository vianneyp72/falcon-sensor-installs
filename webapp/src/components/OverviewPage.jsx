import { Link } from "react-router-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import StatusBadge from "./StatusBadge";

export default function OverviewPage({ section }) {
  // If it's the root manifest (array), show a homepage
  if (Array.isArray(section)) {
    return (
      <>
        <main className="content-area">
          <h1>Falcon Cloud Security - Sensor Installs</h1>
          <p>
            Hands-on lab guides for deploying CrowdStrike Falcon sensors across
            cloud workloads. Choose a compute type to get started.
          </p>
          <p style={{ fontSize: "0.85rem", color: "var(--text-muted)" }}>
            Packages available at{" "}
            <a
              href="https://artifactory.cicd.dc/ui/packages"
              target="_blank"
              rel="noopener noreferrer"
            >
              artifactory.cicd.dc/ui/packages
            </a>
          </p>
          <div className="overview-grid">
            {section.map((s) => (
              <Link key={s.route} to={`/${s.route}`} className="overview-card">
                <div className="overview-card__title">
                  {s.label}
                  <span className="arrow">&rarr;</span>
                </div>
                <div className="overview-card__desc">
                  {s.children?.length || 0} deployment methods
                </div>
              </Link>
            ))}
          </div>
        </main>
        <aside className="toc-aside" />
      </>
    );
  }

  // Section overview
  const flatChildren = [];
  if (section.children) {
    for (const child of section.children) {
      if (child.children) {
        for (const leaf of child.children) {
          flatChildren.push({ ...leaf, group: child.label });
        }
      } else {
        flatChildren.push(child);
      }
    }
  }

  return (
    <>
      <main className="content-area">
        <h1>{section.label}</h1>
        {section.overview && (
          <div style={{ marginBottom: "1.5rem" }}>
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
              {section.overview}
            </Markdown>
          </div>
        )}
        <div className="overview-grid">
          {flatChildren.map((child) => (
            <Link
              key={child.fullRoute}
              to={`/${child.fullRoute}`}
              className="overview-card"
            >
              <div className="overview-card__title">
                {child.label}
                <span className="arrow">&rarr;</span>
              </div>
              {child.group && (
                <div
                  style={{
                    fontSize: "0.72rem",
                    color: "var(--text-muted)",
                    marginBottom: "0.25rem",
                  }}
                >
                  {child.group}
                </div>
              )}
              <div className="overview-card__desc">
                {child.description || "Lab guide"}
              </div>
              <div className="overview-card__status">
                <StatusBadge status={child.status} />
              </div>
            </Link>
          ))}
        </div>
      </main>
      <aside className="toc-aside" />
    </>
  );
}
