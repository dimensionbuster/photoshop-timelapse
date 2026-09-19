// Runs as npm's "version" lifecycle hook (see package.json) so `npm version
// <bump>` keeps manifest.json's version in step with package.json's instead
// of relying on someone remembering to edit it by hand.
const fs = require("fs");
const path = require("path");

const pkgPath = path.join(__dirname, "..", "package.json");
const manifestPath = path.join(__dirname, "..", "manifest.json");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const manifestText = fs.readFileSync(manifestPath, "utf8");

// Regex replace on the raw text (rather than JSON.parse + stringify) so this
// only touches the version line and leaves the rest of manifest.json's
// formatting untouched.
const versionLine = /("version"\s*:\s*")[^"]*(")/;
if (!versionLine.test(manifestText)) {
  throw new Error('manifest.json: no "version" field found');
}
const updated = manifestText.replace(versionLine, `$1${pkg.version}$2`);

fs.writeFileSync(manifestPath, updated);

console.log(`manifest.json version -> ${pkg.version}`);
