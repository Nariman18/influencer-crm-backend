const { PrismaClient, UserRole } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

async function seedManagers() {
  const managers = [
    {
      name: "Melik",
      email: "melik@gmail.com",
      password: "melikVP",
      role: UserRole.MANAGER,
    },
    {
      name: "Cavidan",
      email: "cavidan1999@gmail.com",
      password: "140825",
      role: UserRole.MANAGER,
    },
    {
      name: "Alik",
      email: "alik@gmail.com",
      password: "alik18",
      role: UserRole.MANAGER,
    },
    {
      name: "Nariman",
      email: "nariman18@gmail.com",
      password: "nariman18",
      role: UserRole.MANAGER,
    },
    {
      name: "Rostyslav",
      email: "sofiaaatig@gmail.com",
      password: "Sofia1990",
      role: UserRole.MANAGER,
    },
  ];

  console.log("Seeding managers...");

  for (const managerData of managers) {
    try {
      const hashedPassword = await bcrypt.hash(managerData.password, 12);

      await prisma.user.upsert({
        where: { email: managerData.email },
        update: {
          name: managerData.name,
          role: managerData.role,
        },
        create: {
          name: managerData.name,
          email: managerData.email,
          password: hashedPassword,
          role: managerData.role,
        },
      });

      console.log(`✅ Created/Updated manager: ${managerData.name}`);
    } catch (error) {
      console.error(`❌ Error creating manager ${managerData.name}:`, error);
    }
  }

  console.log("🎉 Managers seeding completed!");
  await prisma.$disconnect();
}

seedManagers().catch(console.error);
