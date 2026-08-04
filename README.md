This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Face Verification Service

Attendance face verification uses a local Python InsightFace service. Run the service from `face-service/`, then set these environment variables for the Next.js app:

```bash
FACE_SERVICE_URL=http://YOUR_PROXMOX_VM_IP:8001
FACE_SERVICE_API_KEY=change-this-long-random-key
FACE_MATCH_PROVIDER=insightface
FACE_ENCRYPTION_KEY=change-this-long-random-secret
KIOSK_CHALLENGE_SECRET=change-this-other-long-random-secret
```

Employees must re-enroll face templates after switching to InsightFace.
See [attendance face security](docs/ATTENDANCE_FACE_SECURITY.md) for threat model,
challenge flow, migration, deployment, testing, and current passive-PAD limits.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
