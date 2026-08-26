# น่วม Thai Massage — Railway Deploy

## วิธี deploy ด้วยตัวเอง (Railway CLI)

1. ติดตั้ง Railway CLI (ถ้ายังไม่มี):
   npm install -g @railway/cli

2. ล็อกอิน:
   railway login

3. อยู่ในโฟลเดอร์นี้ แล้วสร้างโปรเจกต์ใหม่:
   railway init

4. Deploy:
   railway up

5. เปิดโดเมนสาธารณะ:
   railway domain

เว็บเป็น static HTML ไฟล์เดียว (index.html) เสิร์ฟผ่าน Express (server.js) — ไม่ต้องตั้งค่าอะไรเพิ่มเติม Railway จะ detect เป็น Node.js project อัตโนมัติจาก package.json
