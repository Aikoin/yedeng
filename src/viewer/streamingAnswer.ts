/** Batch transport chunks into readable updates; never scroll or start model requests. */
export function createStreamingAnswer(paint:(text:string)=>void, interval=120) {
  let text='',timer:ReturnType<typeof setTimeout>|undefined,closed=false;
  return {
    push(delta:string){
      if(closed)return;text+=delta;
      if(timer===undefined)timer=setTimeout(()=>{timer=undefined;if(!closed)paint(text);},interval);
    },
    stop(){closed=true;if(timer!==undefined)clearTimeout(timer);timer=undefined;},
  };
}

/** Only used for previews: leave the persisted/final Markdown completely untouched. */
export function streamingPreview(text:string):string {
  let fence='',pending=-1,kind='',offset=0;
  for(const line of text.split('\n')){
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if(marker){if(!fence)fence=marker;else if(marker[0]===fence[0]&&marker.length>=fence.length)fence='';offset+=line.length+1;continue;}
    if(!fence){
      // Display math starts on its own line. Code and inline dollar amounts remain literal.
      if(pending<0){const start=line.match(/^\s*(\$\$|\\\[)/);if(start){pending=offset+line.indexOf(start[1]);kind=start[1];}}
      if(pending>=0){const end=kind==='$$'?'$$':'\\]';const searchFrom=Math.max(0,pending-offset+kind.length);
        if(line.indexOf(end,searchFrom)>=0){pending=-1;kind='';}}
    }
    offset+=line.length+1;
  }
  if(pending>=0)return text.slice(0,pending)+'\n\n*公式生成中…*';
  // Don't expose a half-written source ID while the next chunk is arriving.
  return fence?text:text.replace(/\[(?:E\d*|p\.\d*)$/,'');
}
