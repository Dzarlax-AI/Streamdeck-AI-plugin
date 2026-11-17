export function pluginVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Plugin releases require a stable major.minor.patch package version');
  }
  const parts = version.split('.');
  if (parts.some(part => Number(part) > 65535)) {
    throw new Error('Plugin version components must not exceed 65535');
  }
  return `${version}.0`;
}

export function createPluginManifest(manifest, pkg) {
  return { ...manifest, Version: pluginVersion(pkg.version) };
}
