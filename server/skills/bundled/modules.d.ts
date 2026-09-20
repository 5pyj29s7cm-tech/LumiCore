declare module 'mailparser' {
  export function simpleParser(source: Buffer | string, options?: any): Promise<any>;
}

declare module 'sharp' {
  function sharp(input?: string | Buffer, options?: { limitInputPixels?: number }): any;
  export default sharp;
}

declare module 'pdf-lib' {
  export class PDFDocument {
    static create(): Promise<PDFDocument>;
    static load(bytes: Uint8Array | ArrayBuffer): Promise<PDFDocument>;
    getPageIndices(): number[];
    getPageCount(): number;
    getPages(): any[];
    getTitle(): string | undefined;
    getAuthor(): string | undefined;
    getCreator(): string | undefined;
    copyPages(src: PDFDocument, indices: number[]): Promise<any[]>;
    addPage(page?: any): any;
    save(): Promise<Uint8Array>;
  }
}

declare module 'cheerio' {
  export function load(html: string): any;
}
