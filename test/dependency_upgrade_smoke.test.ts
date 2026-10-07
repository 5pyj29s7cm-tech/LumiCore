import { expect, it } from 'vitest';
import http from 'node:http';
import sharp from 'sharp';
import nodemailer from 'nodemailer';
import axios from 'axios';
import { request } from 'undici';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
it('performs MCP initialization, discovery and tool invocation with the upgraded SDK',async()=>{
 const server=new Server({name:'audit-fixture',version:'1.0.0'},{capabilities:{tools:{}}});
 server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',description:'fixture',inputSchema:{type:'object',properties:{},additionalProperties:false}}]}));
 server.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:'fixture OK'}]}));
 const client=new Client({name:'audit-client',version:'1.0.0'});
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
 try{await server.connect(serverTransport);await client.connect(clientTransport);expect((await client.listTools()).tools[0].name).toBe('echo');expect((await client.callTool({name:'echo',arguments:{}})).content).toEqual([{type:'text',text:'fixture OK'}]);}
 finally{await client.close();await server.close();}
});
it('loads the upgraded native Sharp binding and transforms a real image',async()=>{
 const image=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="16" height="12" fill="#44cc77"/></svg>')).png().toBuffer();
 const resized=await sharp(image).resize(8,6).webp().toBuffer();
 expect(await sharp(resized).metadata()).toMatchObject({format:'webp',width:8,height:6});
});
it('builds MIME email without sending a message',async()=>{
 const transporter=nodemailer.createTransport({streamTransport:true,buffer:true});
 const info=await transporter.sendMail({from:'audit@example.invalid',to:'fixture@example.invalid',subject:'审计 fixture',text:'synthetic content',attachments:[{filename:'fixture.txt',content:'fixture'}]});
 expect(Buffer.isBuffer(info.message)).toBe(true);expect(info.message.toString()).toContain('fixture.txt');transporter.close();
});
it('uses Axios and Undici against only a loopback HTTP fixture',async()=>{
 const server=http.createServer((_,res)=>{res.setHeader('Content-Type','application/json');res.end('{"fixture":true}');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;
 try{expect((await axios.get('http://127.0.0.1:'+port,{proxy:false})).data).toEqual({fixture:true});const result=await request('http://127.0.0.1:'+port);expect(await result.body.json()).toEqual({fixture:true});}
 finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
it('extracts DOCX text through the retained Mammoth library API',async()=>{
 const zip=new JSZip();
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>fixture document</w:t></w:r></w:p></w:body></w:document>');
 const result=await mammoth.extractRawText({buffer:await zip.generateAsync({type:'nodebuffer'})});expect(result.value).toContain('fixture document');
});
