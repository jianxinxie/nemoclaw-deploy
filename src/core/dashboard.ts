interface DashboardConfig {
  services?: { dashboardRemoteAccess?: boolean };
  environment?: Record<string, unknown>;
}

/** Explicit YAML wins over legacy environment configuration and the host shell. */
export function resolveDashboardRemoteAccess(config: DashboardConfig): boolean {
  const configured = config.services?.dashboardRemoteAccess;
  if (configured !== undefined) return configured;

  const bind = config.environment?.NEMOCLAW_DASHBOARD_BIND ?? process.env.NEMOCLAW_DASHBOARD_BIND ?? '';
  if (bind !== '' && bind !== '0.0.0.0') {
    throw new Error('NEMOCLAW_DASHBOARD_BIND 只能为空或 0.0.0.0；也可以设置 onboard.services.dashboardRemoteAccess: true/false');
  }
  return bind === '0.0.0.0';
}

export function dashboardEnvironment(remoteAccess: boolean): Record<string, string> {
  // Upstream rejects 127.0.0.1 as an explicit value. Empty clears an inherited
  // opt-in and uses the upstream default (loopback outside WSL).
  return { NEMOCLAW_DASHBOARD_BIND: remoteAccess ? '0.0.0.0' : '' };
}

export function dashboardBindLabel(remoteAccess: boolean): string {
  return remoteAccess ? '0.0.0.0 (remote access enabled)' : 'default (loopback outside WSL)';
}
