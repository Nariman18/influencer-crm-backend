const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const emails = await prisma.email.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      subject: true,
      sentAt: true,
      gmailMessageId: true,
      createdAt: true,
      influencer: {
        select: {
          email: true,
          status: true
        }
      }
    }
  });

  console.log('\n📧 Last 5 emails in database:\n');
  emails.forEach((email, i) => {
    console.log(`${i + 1}. Email ID: ${email.id}`);
    console.log(`   Status: ${email.status}`);
    console.log(`   To: ${email.influencer.email}`);
    console.log(`   Subject: ${email.subject.substring(0, 50)}...`);
    console.log(`   Message ID: ${email.gmailMessageId || 'NULL'}`);
    console.log(`   Sent At: ${email.sentAt || 'NULL'}`);
    console.log(`   Influencer Status: ${email.influencer.status}`);
    console.log(`   Created: ${email.createdAt}`);
    console.log('');
  });

  await prisma.$disconnect();
}

main().catch(console.error);
