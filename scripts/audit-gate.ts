import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface AllowlistEntry {
  expiry: string;
  ticket?: string;
  justification?: string;
}

interface Allowlist {
  vulnerabilities: Record<string, AllowlistEntry>;
  outdated: Record<string, AllowlistEntry>;
}

export function loadAllowlist(filePath: string): Allowlist {
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

export function validateOverride(name: string, entry: AllowlistEntry): string | null {
  const expiryDate = new Date(entry.expiry);
  if (isNaN(expiryDate.getTime())) {
    return `Invalid expiry date format for ${name}`;
  }
  if (expiryDate <= new Date()) {
    return `Override for ${name} has expired on ${entry.expiry}`;
  }
  if (!entry.ticket && !entry.justification) {
    return `Override for ${name} must have a ticket or justification`;
  }
  return null;
}

export function checkVulnerabilities(auditJson: string, allowlist: Allowlist): string[] {
  const errors: string[] = [];
  let audit;
  try {
    audit = JSON.parse(auditJson);
  } catch (e) {
    return ['Failed to parse npm audit output'];
  }

  if (audit && audit.vulnerabilities) {
    for (const [vulnName, vulnData] of Object.entries<any>(audit.vulnerabilities)) {
      const allowed = allowlist.vulnerabilities[vulnName];
      if (allowed) {
        const err = validateOverride(vulnName, allowed);
        if (err) errors.push(err);
      } else {
        errors.push(`Vulnerability found: ${vulnName} (Severity: ${vulnData.severity})`);
      }
    }
  }
  return errors;
}

export function checkOutdated(outdatedJson: string, allowlist: Allowlist, packageJsonPath: string): string[] {
  const errors: string[] = [];
  let outdated;
  try {
    outdated = JSON.parse(outdatedJson);
  } catch (e) {
    // npm outdated might output nothing if all good
    if (outdatedJson.trim() === '') return [];
    return ['Failed to parse npm outdated output'];
  }

  // Load package.json to determine critical (prod) dependencies
  const pkgContent = fs.readFileSync(packageJsonPath, 'utf8');
  const pkg = JSON.parse(pkgContent);
  const prodDeps = pkg.dependencies || {};

  if (outdated) {
    for (const [pkgName, details] of Object.entries<any>(outdated)) {
      // Only consider it a failure if it's a prod dependency
      if (prodDeps[pkgName]) {
        const allowed = allowlist.outdated[pkgName];
        if (allowed) {
          const err = validateOverride(pkgName, allowed);
          if (err) errors.push(err);
        } else {
          errors.push(`Critical dependency outdated: ${pkgName} (Current: ${details.wanted}, Latest: ${details.latest})`);
        }
      }
    }
  }
  return errors;
}

export function runGate() {
  const allowlistPath = path.join(__dirname, '../security/allowlist.json');
  const packageJsonPath = path.join(__dirname, '../package.json');
  
  if (!fs.existsSync(allowlistPath)) {
    console.error('Missing security/allowlist.json');
    process.exit(1);
  }

  const allowlist = loadAllowlist(allowlistPath);
  let hasErrors = false;

  console.log('Running npm audit...');
  let auditOutput = '';
  try {
    auditOutput = execSync('npm audit --omit=dev --json', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (err: any) {
    // npm audit returns non-zero if vulnerabilities are found
    auditOutput = err.stdout?.toString() || '';
  }

  const vulnErrors = checkVulnerabilities(auditOutput, allowlist);
  if (vulnErrors.length > 0) {
    console.error('\\n--- Vulnerability Errors ---');
    vulnErrors.forEach(e => console.error(e));
    hasErrors = true;
  } else {
    console.log('No unallowed vulnerabilities found.');
  }

  console.log('\\nRunning secondary scanner (npm outdated)...');
  let outdatedOutput = '';
  try {
    outdatedOutput = execSync('npm outdated --json', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (err: any) {
    // npm outdated returns non-zero if outdated packages exist
    outdatedOutput = err.stdout?.toString() || '';
  }

  const outErrors = checkOutdated(outdatedOutput, allowlist, packageJsonPath);
  if (outErrors.length > 0) {
    console.error('\\n--- Outdated Critical Dependencies ---');
    outErrors.forEach(e => console.error(e));
    hasErrors = true;
  } else {
    console.log('No unallowed outdated critical dependencies found.');
  }

  if (hasErrors) {
    console.error('\\nCI Gate Failed.');
    process.exit(1);
  } else {
    console.log('\\nCI Gate Passed.');
    process.exit(0);
  }
}

if (require.main === module) {
  runGate();
}
