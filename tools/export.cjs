// Usage: node export.cjs <score.mscz> <outdir>
// Reads a MuseScore file with webmscore (MuseScore compiled to WebAssembly)
// and writes score.musicxml, score.mid and metadata.json.
// The two lines below work around webmscore's browser detection on Node 21+.
globalThis.fetch=undefined;
Object.defineProperty(globalThis,'navigator',{value:undefined,writable:true,configurable:true});
const fs=require('fs'), path=require('path');
const WebMscore=require('webmscore').default||require('webmscore');
(async()=>{
  const [,,inFile,outDir]=process.argv;
  fs.mkdirSync(outDir,{recursive:true});
  await WebMscore.ready;
  const score=await WebMscore.load('mscz', fs.readFileSync(inFile), [], true);
  const n=await score.npages();
  console.log('pages',n);
  const meta=await score.metadata();
  fs.writeFileSync(path.join(outDir,'metadata.json'),JSON.stringify(meta,null,1));
  fs.writeFileSync(path.join(outDir,'score.mid'),Buffer.from(await score.saveMidi(true,false)));
  fs.writeFileSync(path.join(outDir,'score.musicxml'),await score.saveXml());
  score.destroy();
  console.log('done');
})().catch(e=>{console.error('ERR',e);process.exit(1)});
