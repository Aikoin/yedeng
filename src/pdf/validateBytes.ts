/** Reject obvious web responses before PDF.js attempts expensive recovery parsing. */
export function validatePdfBytes(bytes:ArrayBuffer):void {
 const prefix=new TextDecoder().decode(new Uint8Array(bytes,0,Math.min(bytes.byteLength,1024)));
 if(!bytes.byteLength)throw new Error('文件内容为空，请重新下载 PDF');
 // Permit real PDFs even when the server labels them text/html, and tolerate leading bytes.
 if(prefix.includes('%PDF-'))return;
 if(/^\s*(?:\uFEFF)?\s*(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|<script\b|<!--)/i.test(prefix))
  throw new Error('收到的是网页，不是 PDF。可能是登录页、访问验证页或下载链接已失效。请在原网站打开或下载 PDF 后重试。');
}
