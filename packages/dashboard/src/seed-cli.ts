import { seedIfEmpty } from "./seed.js";

const seeded = seedIfEmpty(true);
console.log(seeded ? "Seeded sample dashboard data." : "Nothing to seed.");
