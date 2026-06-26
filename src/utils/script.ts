export function nodeEvalScript(script: string): string {
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `eval(Buffer.from('${encoded}','base64').toString('utf8'))`;
}
