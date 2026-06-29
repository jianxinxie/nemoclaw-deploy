export function maskSecret(value?: string): string {
  if (!value) return '';
  if (value.length <= 8) return '******';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function maskSensitiveText(input: string, secrets: string[] = []): string {
  let output = input;

  for (const secret of secrets) {
    if (secret) {
      output = output.split(secret).join('******');
    }
  }

  output = output.replace(/("gatewayToken"\s*:\s*")([^"]+)(")/gi, '$1******$3');
  output = output.replace(/(GATEWAY_TOKEN=)([^\s'"]+)/g, '$1******');
  output = output.replace(/\bnpm_[A-Za-z0-9]{20,}\b/g, 'npm_******');
  output = output.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=)([^\s'"]+)/gi, '$1******');
  output = output.replace(/([?&#]token=)([^&#\s]+)/gi, '$1******');

  return output;
}
