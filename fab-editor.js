// fab-editor.js
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const fse = require("fs-extra");
const socketIO = require("socket.io");

module.exports = function(RED) {

  function FabEditorNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    const port = config.port || 7007;
    const enableLock = config.enableLock !== false;
    let areas = [];
    let useAreaDir = config.useAreaDir !== false;
    let textFormats = [];
    let mediaFormats = [];
    let sourceDir = config.sourceDir || "";
    let exportDir = config.exportDir || "";
    let tempDir = config.tempDir || "";
    const linesVisible = parseInt(config.visibleRows || "5",10);
    const maxChars = parseInt(config.maxChars || "36", 10);

    try { areas = JSON.parse(config.areas || '["News","Wetter","Sport"]'); } catch(e){ areas=["News","Wetter","Sport"]; }
    try { textFormats = JSON.parse(config.textFormats || '["srt","ass"]'); } catch(e){ textFormats=["srt","ass"]; }
    try { mediaFormats = JSON.parse(config.mediaFormats || '["mp3","mp4"]'); } catch(e){ mediaFormats=["mp3","mp4"]; }

    const app = express();
    const server = http.createServer(app);
    const io = new socketIO.Server(server,{ cors:{ origin:"*" }});

    // Serve Editor
    app.get("/editor",(req,res)=>{
      res.sendFile(path.join(__dirname,"fab-editor-index.html"));
    });

    // Serve media => /files
    if(useAreaDir && areas.length>0){
      areas.forEach(a=>{
        const dirPath= path.join(sourceDir,a);
        if(fs.existsSync(dirPath)){
          app.use(`/files/${a}`, express.static(dirPath));
        }
      });
    } else {
      app.use("/files", express.static(sourceDir));
    }

    let fileLocks = {};
    let fileEdits = {}; // lastBrowserEdit timestamps

    io.on("connection",(socket)=>{
      node.log("Client connected:"+socket.id);

      socket.emit("config", {
        enableLock, areas, useAreaDir, textFormats, mediaFormats, sourceDir, exportDir, linesVisible, maxChars
      });

      // listFiles
      socket.on("listFiles",(data)=>{
        const bereich= data && data.bereich? data.bereich:"";
        let folder= sourceDir;
        if(useAreaDir && bereich && areas.includes(bereich)){
          folder= path.join(sourceDir, bereich);
        }
        if(!fs.existsSync(folder)){
          socket.emit("listFilesResult",[]);
          return;
        }
        const all= fs.readdirSync(folder,{withFileTypes:true}).filter(e=>e.isFile());
        let result=[];
        all.forEach(dirent=>{
          const ext= path.extname(dirent.name).replace(".","").toLowerCase();
          if(textFormats.includes(ext) || mediaFormats.includes(ext)){
            const fullPath= path.join(folder, dirent.name);
            const locked= !!fileLocks[fullPath];
            const st= fs.statSync(fullPath);
            const creationDate= st.birthtimeMs;
            const lastBrowserEdit= fileEdits[fullPath]?.lastBrowserEdit||0;
            result.push({
              name:dirent.name,
              ext,
              locked,
              creationDate,
              lastBrowserEdit
            });
          }
        });
        socket.emit("listFilesResult", result);
      });

      // loadFile
      socket.on("loadFile",(data)=>{
        const { fileName, bereich, force }= data;
        let folder= sourceDir;
        if(useAreaDir && bereich && areas.includes(bereich)){
          folder= path.join(sourceDir, bereich);
        }
        const fullPath= path.join(folder, fileName);
        if(!fs.existsSync(fullPath)){
          socket.emit("loadFileResult",{ error:"Datei nicht gefunden" });
          return;
        }

        if(!enableLock){
          let content= readFileOrTemp(fullPath,fileName, bereich);
          socket.emit("loadFileResult",{ locked:false, content });
          return;
        }

        // lock logic
        const lockInfo= fileLocks[fullPath];
        if(!lockInfo){
          fileLocks[fullPath]={ user:socket.id, time:Date.now() };
          let content= readFileOrTemp(fullPath,fileName, bereich);
          socket.emit("loadFileResult",{ locked:false, content });
          return;
        }
        if(lockInfo.user===socket.id){
          let content= readFileOrTemp(fullPath,fileName, bereich);
          socket.emit("loadFileResult",{ locked:false, content });
          return;
        }
        // locked by another user
        if(!force){
          socket.emit("loadFileResult",{ locked:true });
        } else {
          const oldOwner= lockInfo.user;
          fileLocks[fullPath]={ user:socket.id, time:Date.now() };
          io.to(oldOwner).emit("lockTaken",{ fileName, by: socket.id });
          let content= readFileOrTemp(fullPath,fileName, bereich);
          socket.emit("loadFileResult",{ locked:false, content });
        }
      });

      // unlockFile
      socket.on("unlockFile",(data)=>{
        const { fileName, bereich }= data;
        let folder= sourceDir;
        if(useAreaDir && bereich && areas.includes(bereich)){
          folder= path.join(sourceDir, bereich);
        }
        const fullPath= path.join(folder,fileName);
        if(fileLocks[fullPath]) delete fileLocks[fullPath];
        socket.emit("unlockFileResult",{ success:true });
      });

      // exportFile => write + unlock
      socket.on("exportFile",(data)=>{
        const { fileName, bereich, content }= data;
        let folder= exportDir;
        if(useAreaDir && bereich && areas.includes(bereich)){
          folder= path.join(exportDir, bereich);
        }
        fse.ensureDirSync(folder);
        const outPath= path.join(folder, fileName);
        fs.writeFileSync(outPath, content,"utf8");

        let srcFolder= sourceDir;
        if(useAreaDir && bereich && areas.includes(bereich)){
          srcFolder= path.join(sourceDir, bereich);
        }
        const fullPath= path.join(srcFolder,fileName);
        if(fileLocks[fullPath]) delete fileLocks[fullPath];

        fileEdits[fullPath]={ lastBrowserEdit: Date.now() };

        node.send({
          topic:"export",
          payload:{ fileName, bereich, outPath }
        });
        socket.emit("exportFileResult",{ success:true, outPath });
      });

      // saveTempFile => autosave
      socket.on("saveTempFile",(data)=>{
        const { fileName, bereich, content }= data;
        if(!tempDir){
          socket.emit("saveTempFileResult",{ error:"Kein tempDir konfiguriert" });
          return;
        }
        fse.ensureDirSync(tempDir);
        let tmpFile= fileName+".tmp";
        if(bereich && areas.includes(bereich) && useAreaDir){
          tmpFile= bereich+"_"+tmpFile;
        }
        const tempPath= path.join(tempDir, tmpFile);
        fs.writeFileSync(tempPath, content,"utf8");

        let folder= sourceDir;
        if(useAreaDir && bereich && areas.includes(bereich)){
          folder= path.join(sourceDir, bereich);
        }
        const fullPath= path.join(folder, fileName);
        fileEdits[fullPath]={ lastBrowserEdit: Date.now() };

        node.log(`saveTempFile: ${tempPath} aktualisiert.`);
        socket.emit("saveTempFileResult",{ success:true, tempPath });
      });

      socket.on("disconnect",()=>{
        node.log("Client disconnected:"+socket.id);
      });
    });

    let cleanupInterval=null;
    if(tempDir){
      cleanupInterval=setInterval(()=>cleanupTempFiles(tempDir),3600000);
      cleanupTempFiles(tempDir);
    }

    server.listen(port,()=>{
      node.log(`fab-editor listening on port ${port}`);
    });

    node.on("input",(msg)=> node.send(msg));

    node.on("close",(done)=>{
      if(cleanupInterval){
        clearInterval(cleanupInterval);
        cleanupInterval=null;
      }
      io.close();
      server.close(()=> done());
    });

    function readFileOrTemp(fullPath,fileName,bereich){
      if(!tempDir) return fs.readFileSync(fullPath,"utf8");
      let tmpFile= fileName+".tmp";
      if(bereich && useAreaDir){
        tmpFile= bereich+"_"+tmpFile;
      }
      const candidate= path.join(tempDir, tmpFile);
      if(fs.existsSync(candidate)){
        node.log(`LoadFile: using TempFile => ${candidate}`);
        return fs.readFileSync(candidate,"utf8");
      }
      return fs.readFileSync(fullPath,"utf8");
    }

    function cleanupTempFiles(dir){
      if(!fs.existsSync(dir)) return;
      const now= Date.now();
      const limit= 5*24*60*60*1000; // 5 days
      const all= fs.readdirSync(dir,{withFileTypes:true});
      all.forEach(e=>{
        if(e.isFile()){
          const full= path.join(dir,e.name);
          const st= fs.statSync(full);
          if(now - st.ctimeMs>limit){
            fs.unlinkSync(full);
            node.log(`TempFile gelöscht: ${e.name}`);
          }
        }
      });
    }
  }

  RED.nodes.registerType("fab-editor", FabEditorNode);
};
