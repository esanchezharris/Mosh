#version 300 es
precision highp float;
out vec4 O;
uniform vec2 uRes; uniform float uTime,uPlayhead,uPlaying;
uniform int uMode,uCount,uColorMode; uniform float uNCols,uBeats;
uniform sampler2D uData;
uniform vec3 uLow,uMid,uHigh,uMono,uDuoA,uDuoB,uBg,uGlow;
uniform float uGlowFollow;
uniform float uGoo,uWeld,uMerge,uGlass,uMetal,uGloss,uRim,uHalf,uGrain,uFill;
uniform float uWake,uTrail,uFlow,uFlowSpd,uIdle;
uniform float uThick,uSym,uRhythm,uNoteH,uAtk,uRel,uHitR,uPulse;

float hash(vec2 p){return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}
float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<4;i++){s+=a*vnoise(p);p*=2.02;a*=.5;}return s;}
float smin(float a,float b,float k){if(k<1e-4)return min(a,b);
  float h=clamp(.5+.5*(b-a)/k,0.,1.);return mix(b,a,h)-k*h*(1.-h);}
float sdSeg(vec2 p,float cx,float cy,float h,float r){vec2 q=vec2(p.x-cx,max(abs(p.y-cy)-h,0.));return length(q)-r;}
float sdBox(vec2 p,vec2 b,float r){vec2 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,q.y),0.)-r;}
vec3 pitchTint(float t){return t<.5?mix(uLow,uMid,t*2.):mix(uMid,uHigh,(t-.5)*2.);}

float beatEmph(float x, float div, float sharp){
  float f=fract(x*div); float dline=min(f,1.-f);
  return exp(-dline*dline*sharp);
}

vec3 background(vec2 uv){
  vec3 c=uBg;
  if(uMode==1){float row=floor(uv.y*13.); c+=mod(row,2.)*0.012;}
  return c;
}

void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  float W=uRes.x,H=uRes.y,dpr=clamp(H/340.,1.,2.5);
  vec2 pc=vec2(gl_FragCoord.x,gl_FragCoord.y-H*.5);
  float aa=1.3;

  float dph=uv.x-uPlayhead;
  float wband=exp(-dph*dph*220.);
  float wtrail=uv.x<uPlayhead?exp(-(uPlayhead-uv.x)/max(uTrail,1e-3)):0.;
  float wakeF=uWake*(wband+wtrail*.5);
  float idle=uIdle*(.5+.5*sin(uTime*1.6))*(1.-uPlaying*.6);

  float bars=max(uBeats*.25,1.);
  float eDown=beatEmph(uv.x,bars,900.);
  float eBeat=beatEmph(uv.x,uBeats,1400.);
  float e16=beatEmph(uv.x,uBeats*4.,2600.);
  float rhythm=uRhythm*(eDown*1.0+eBeat*.5+e16*.22);

  float d=1e6; vec3 tint=vec3(.8); float actGlow=0.;

  if(uMode==0){
    float energy=texture(uData,vec2(uPlayhead,.5)).r;
    float ripple=sin(pc.y*.09-uTime*8.)*10.*wakeF*(.4+energy);
    float sx=gl_FragCoord.x+ripple;
    float colW=W/uNCols; float c0=floor(sx/colW); float k=uGoo*colW*3.4;
    vec3 acc=vec3(0.); float ws=0.;
    for(int j=-3;j<=3;j++){float ci=c0+float(j);
      if(ci<0.||ci>=uNCols)continue;
      float cx01=(ci+.5)/uNCols; vec4 t=texture(uData,vec2(cx01,.5));
      float b=exp(-pow((cx01-uPlayhead)*16.,2.));
      float rEmph=uRhythm*(beatEmph(cx01,bars,900.)*1.+beatEmph(cx01,uBeats,1400.)*.5+beatEmph(cx01,uBeats*4.,2600.)*.22);
      float amp=t.r*(1.+.35*uWake*b)*(1.-uRhythm*.28+rEmph*.5);
      float h=amp*H*.42*uThick;
      float cy=uSym>.5?0.:-H*.44+h;
      float r=colW*(.34+.20*t.r);
      float dj=sdSeg(vec2(sx,pc.y),(ci+.5)*colW,cy,h,r);
      d=smin(d,dj,k);
      float wg=exp(-max(dj,0.)*.14);
      acc+=(t.g*uLow+t.b*uMid+t.a*uHigh)/max(t.g+t.b+t.a,1e-3)*wg; ws+=wg;
    }
    tint=acc/max(ws,1e-4);
  } else if(uMode==1){
    float k=uWeld*H*.020; vec3 acc=vec3(0.); float ws=0.;
    for(int i=0;i<64;i++){if(i>=uCount)break;
      vec4 n=texelFetch(uData,ivec2(i,0),0);
      float x0=n.x*W,x1=(n.x+n.y)*W,cx=(x0+x1)*.5,cy=(n.z-.5)*H*.82;
      float hw=(x1-x0)*.5,hh=H*.032*(.55+.9*n.w)*uNoteH;
      if(abs(gl_FragCoord.x-cx)>hw+30.*dpr&&abs(pc.y-cy)>hh+30.*dpr)continue;
      float rr=hh*.6;
      float inN=smoothstep(n.x-uAtk,n.x,uPlayhead)-smoothstep(n.x+n.y,n.x+n.y+.001,uPlayhead);
      float rel=uPlayhead>n.x+n.y?exp(-(uPlayhead-(n.x+n.y))/max(uRel,1e-3)):0.;
      float act=clamp(max(inN,rel),0.,1.);
      float dj=sdBox(vec2(gl_FragCoord.x,pc.y)-vec2(cx,cy),vec2(hw,hh*(1.+.35*act)),rr);
      d=smin(d,dj,k);
      float wg=exp(-max(dj,0.)*.12);
      acc+=pitchTint(n.z)*(1.+act*.9)*wg; ws+=wg; actGlow+=act*exp(-max(dj,0.)*.09);
    }
    tint=acc/max(ws,1e-4);
  } else {
    float k=uMerge*H*.030; vec3 acc=vec3(0.); float ws=0.;
    for(int i=0;i<64;i++){if(i>=uCount)break;
      vec4 hn=texelFetch(uData,ivec2(i,0),0);
      float hx=hn.x*W,lane=hn.y,cy=(.80-lane*.20-.5)*H;
      float r=(H*.028+hn.z*H*.075)*uHitR;
      if(abs(gl_FragCoord.x-hx)>r+40.*dpr&&abs(pc.y-cy)>r+40.*dpr)continue;
      float ts=uPlayhead-hn.x; if(ts<0.)ts+=1.;
      float pulse=exp(-ts*13.)*uPulse; float rr=r*(1.+.55*pulse);
      float dj=length(vec2(gl_FragCoord.x,pc.y)-vec2(hx,cy))-rr;
      d=smin(d,dj,k);
      float wg=exp(-max(dj,0.)*.10);
      vec3 lc=lane<.5?uLow:lane<1.5?uMid:lane<2.5?uHigh:mix(uLow,uHigh,.5);
      acc+=lc*(1.+pulse*1.3)*wg; ws+=wg; actGlow+=pulse*exp(-max(dj,0.)*.08);
    }
    tint=acc/max(ws,1e-4);
  }

  vec3 body = uColorMode==1?uMono : uColorMode==2?uDuoA : tint;
  vec3 bgC=background(uv);

  vec2 g=vec2(dFdx(d),dFdy(d)); float glen=length(g); vec2 gn=glen>1e-5?g/glen:vec2(0,1);
  float R=16.*dpr; float hgt=clamp(-d/R,0.,1.); float slope=sqrt(max(1.-hgt*hgt,1e-4));
  vec3 nrm=normalize(vec3(gn*slope,hgt*.9+.25));
  vec3 L=normalize(vec3(-.3,.55,.85));
  float spec=pow(max(dot(nrm,L),0.),mix(6.,64.,uGloss));
  float fres=pow(1.-clamp(nrm.z,0.,1.),3.);
  float fill=smoothstep(aa,-aa,d);
  float rimE=smoothstep(-6.,-.4,d)*fill;
  if(uColorMode==2){float lum=clamp(hgt+rimE*.4+actGlow*.3,0.,1.);body=mix(uDuoA,uDuoB,lum);}

  vec3 shaded=body*(.55+.45*hgt);
  shaded+=spec*uGloss*vec3(1.);
  shaded+=fres*uMetal*mix(body,vec3(1.),.55);
  shaded+=rimE*uRim*body*1.2;
  shaded+=actGlow*(uColorMode==1?uMono:body)*1.1;
  shaded+=wakeF*body*.6;
  if(uMode==0) shaded+=rhythm*mix(body,vec3(1.),.3)*fill*.9;

  if(uFlow>0.001){float fl=fbm(gl_FragCoord.xy*.005+vec2(uTime*uFlowSpd*.4,uTime*uFlowSpd*.1));shaded*=1.+(fl-.5)*uFlow*1.4;}
  if(uHalf>.5&&fill>.01){vec2 hp=gl_FragCoord.xy/(2.6*5.*dpr);float dd=length(fract(hp)-.5);
    float lum=dot(shaded,vec3(.299,.587,.114));float thr=mix(.62,.08,clamp(lum,0.,1.));
    shaded=mix(bgC*1.3,shaded,smoothstep(thr+.06,thr-.06,dd));}
  shaded*=uFill*.4+.6;

  vec3 refr=bgC; if(uGlass>0.001){vec2 off=gn*uGlass*.05*fill; refr=background(uv-off)*1.15;}
  vec3 base=mix(bgC,refr,uGlass*fill*.8);

  vec3 col=mix(base+(wakeF+idle)*(uGlowFollow>.5?body:uGlow)*.5, shaded, fill);

  if(uMode==0){
    float tick=beatEmph(uv.x,uBeats,4000.)*.05 + beatEmph(uv.x,bars,3000.)*.09;
    col+=tick*(1.-fill)*uRhythm*mix(uGlow,vec3(1.),.3);
  }

  float ph=smoothstep(1.7,0.,abs(gl_FragCoord.x-uPlayhead*W));
  col+=ph*mix(vec3(.9,.93,1.),uGlow,.4)*(.35+.4*uWake);
  col+=wtrail*(uGlowFollow>.5?tint:uGlow)*.12*uWake;

  col+=(hash(gl_FragCoord.xy+fract(uTime)*61.)-.5)*.035*(.4+uGrain);
  O=vec4(pow(max(col,0.),vec3(.92)),1.);
}
