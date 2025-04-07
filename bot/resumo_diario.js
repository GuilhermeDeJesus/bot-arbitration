// === resumo_diario.js ===
const fs = require('fs');

const reportData = JSON.parse(fs.readFileSync('report.json', 'utf-8'));

const resumoPorDia = {};

for (const entrada of reportData) {
  const dia = entrada.timestamp.slice(0, 10);
  if (!resumoPorDia[dia]) {
    resumoPorDia[dia] = {
      date: dia,
      totalProfit: 0,
      totalTrades: 0,
      totalLoss: 0
    };
  }

  const lucro = parseFloat(entrada.profit);
  resumoPorDia[dia].totalTrades += 1;

  if (lucro >= 0) {
    resumoPorDia[dia].totalProfit += lucro;
  } else {
    resumoPorDia[dia].totalLoss += Math.abs(lucro);
  }
}

fs.writeFileSync('daily_summary.json', JSON.stringify(Object.values(resumoPorDia), null, 2));
console.log("Resumo diário salvo em daily_summary.json");
