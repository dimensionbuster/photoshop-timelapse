import manifest from "../../../manifest.json";

// Alerts only — UXP plugins loaded outside Adobe Exchange have no sanctioned
// way to replace their own running plugin folder, so this just points the
// user at the GitHub release instead of attempting a self-update.
const REPO = "dimensionbuster/photoshop-timelapse";
const RELEASES_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(RELEASES_API_URL);
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    if (!data.tag_name || !data.html_url) return null;

    const latestVersion = data.tag_name.replace(/^v/, "");
    return {
      available: isNewer(latestVersion, manifest.version),
      currentVersion: manifest.version,
      latestVersion,
      releaseUrl: data.html_url,
    };
  } catch {
    // offline, rate-limited, or GitHub unreachable — fail silently, this is
    // a best-effort notice, not a required part of the app flow.
    return null;
  }
}
