import { describe, expect, it } from 'vitest';
import { formulaRequest, parseFormulaCandidate } from '../src/formula/recognizer';
import { renderFormula } from '../src/formula/render';

describe('formula evidence and candidate contract', () => {
  it('renders inline math without a display block while keeping external commands blocked',()=>{
    const inline=renderFormula(String.raw`QK^{T}`,false);expect(inline.status).toBe('rendered');if(inline.status==='rendered')expect(inline.html).not.toContain('katex-display');
    expect(renderFormula(String.raw`\href{javascript:alert(1)}{x}`,false).status).toBe('unsupported');
  });
  it('rejects remote image URLs and excessive fragments before any request', () => {
    expect(() => formulaRequest(['https://example.com/formula.png'], 'vision')).toThrow();
    expect(() => formulaRequest([], 'vision')).toThrow();
    expect(() => formulaRequest(Array(9).fill('data:image/png;base64,YQ=='), 'vision')).toThrow();
  });
  it('preserves fragment order and marks every response as an unverified candidate', () => {
    const request = formulaRequest(['data:image/png;base64,YQ==','data:image/png;base64,Yg=='], 'vision');
    expect(JSON.stringify(request.messages[1])).toContain('YQ==');
    expect(JSON.stringify(request.messages[1]).indexOf('YQ==')).toBeLessThan(JSON.stringify(request.messages[1]).indexOf('Yg=='));
    expect(parseFormulaCandidate('{"latex":"x_i^2","warnings":[]}').status).toBe('candidate_needs_review');
  });
  it('invalid structured output is an error, never an instruction to retry', () => {
    expect(() => parseFormulaCandidate('x_i')).toThrow(/不自动/);
    expect(() => parseFormulaCandidate('{"latex":"x","warnings":42}')).toThrow();
  });
  it('renders nested structures without claiming recognition correctness', () => {
    for (const source of [String.raw`\frac{1}{\sqrt{x_i^2+1}}`, String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`, String.raw`\begin{cases}x&x>0\\0&x\le0\end{cases}`, String.raw`\begin{aligned}a&=b\\&=c\end{aligned}`]) expect(renderFormula(source).status).toBe('rendered');
  });
  it('unsupported, remote and recursive macros retain a useful fallback', () => {
    for (const source of [String.raw`\unknown{x}`, String.raw`\includegraphics{https://example.com}`, String.raw`\href{https://example.com}{x}`, String.raw`\def\a{\a}\a`]) expect(renderFormula(source).status).toBe('unsupported');
  });
  it('rejects oversized candidates and malformed warning lists while preserving the caller source', () => {
    expect(() => parseFormulaCandidate(JSON.stringify({latex:'x'.repeat(12001),warnings:[]}))).toThrow('长度');
    expect(() => parseFormulaCandidate(JSON.stringify({latex:'x',warnings:Array(33).fill('uncertain')}))).toThrow('疑点');
    expect(renderFormula('x'.repeat(12001)).status).toBe('invalid');
    expect(renderFormula(String.raw`\gdef\z{x}\z`).status).toBe('unsupported');
    expect(renderFormula(String.raw`\def\z{x}\z`).status).toBe('rendered');
    expect(renderFormula(String.raw`\z`).status).toBe('unsupported');
  });

});
