# public/ 의 화면 파일을 합쳐 더블클릭으로 열리는 단일 demo.html 생성
import re, json
p='public/'; r=lambda f: open(p+f,encoding='utf-8').read()
html=r('index.html')
html=html.replace('<link rel="stylesheet" href="/style.css">','<style>'+r('style.css')+'</style>')
fac=open('config/facility.json',encoding='utf-8').read()
scripts='<script>window.DEMO_FACILITY='+fac+'</script>\n<script>'+r('engine.js')+'</script>\n<script>'+r('demo-sim.js')+'</script>\n<script>'+r('app.js')+'</script>'
html=html.replace('<script src="/engine.js"></script>\n<script src="/app.js"></script>',scripts)
html=re.sub(r'<link rel="(manifest|icon|apple-touch-icon)"[^>]*>','',html)
html=re.sub(r'<script>if\("serviceWorker".*?</script>','',html,flags=re.S)
html=html.replace('<title>Rhyturn 관제</title>','<title>Rhyturn 관제 (데모)</title>')
open('demo.html','w',encoding='utf-8').write(html); print('demo.html',len(html))
