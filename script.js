const ranks = [
  {
    name: "Ciudadano",
    price: "€4.99",
    perks: [
      "Prefijo exclusivo en el chat",
      "1 home adicional",
      "Acceso prioritario en horas pico",
    ],
  },
  {
    name: "Diplomático",
    price: "€9.99",
    perks: [
      "Todo lo de Ciudadano",
      "Kit semanal de recursos",
      "Canal privado de comercio en Discord",
    ],
  },
  {
    name: "Senador",
    price: "€19.99",
    perks: [
      "Todo lo de Diplomático",
      "Comando de color de nickname",
      "2 homes extra y recompensas diarias",
    ],
  },
  {
    name: "Canciller",
    price: "€34.99",
    perks: [
      "Todo lo de Senador",
      "Prioridad alta en soporte",
      "Cosméticos exclusivos de temporada",
    ],
  },
];

const cardsContainer = document.getElementById("cards-container");
const sessionText = document.getElementById("session-text");
const paymentsBox = document.getElementById("payments-box");
const navActions = document.getElementById("nav-actions");
const statusMessage = document.getElementById("status-message");

let currentSession = { loggedIn: false, user: null };

function setStatus(message) {
  statusMessage.textContent = message || "";
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { error: raw || "Error inesperado" };
  }
  if (!res.ok) {
    throw new Error(data.error || "Error inesperado");
  }
  return data;
}

function renderNav() {
  if (!currentSession.loggedIn || !currentSession.user) {
    navActions.innerHTML = '<a class="btn btn-outline" href="/auth/microsoft">Iniciar sesión</a>';
    return;
  }

  navActions.innerHTML = `
    <span>${currentSession.user.minecraft_name}</span>
    <a class="btn btn-subtle" href="/auth/logout">Cerrar sesión</a>
  `;
}

function renderCards() {
  cardsContainer.innerHTML = "";

  ranks.forEach((rank) => {
    const card = document.createElement("article");
    card.className = "card";

    card.innerHTML = `
      <p class="rank">${rank.name}</p>
      <p class="price">${rank.price}</p>
      <ul>
        ${rank.perks.map((perk) => `<li>${perk}</li>`).join("")}
      </ul>
      <button class="btn buy-btn" data-rank="${rank.name}" ${
      currentSession.loggedIn ? "" : "disabled"
    }>
        ${currentSession.loggedIn ? `Comprar ${rank.name}` : "Inicia sesión para comprar"}
      </button>
    `;

    cardsContainer.appendChild(card);
  });

  document.querySelectorAll(".buy-btn[data-rank]").forEach((button) => {
    button.addEventListener("click", async () => {
      const rankName = button.getAttribute("data-rank");
      setStatus("Registrando compra...");

      try {
        const data = await fetchJson("/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rankName }),
        });

        setStatus(data.message);
        await loadPayments();
      } catch (error) {
        setStatus(error.message);
      }
    });
  });
}

function renderPayments(payments) {
  if (!payments.length) {
    paymentsBox.innerHTML = "<p style=\"padding:0.8rem;\">Todavía no hay pagos registrados.</p>";
    return;
  }

  const rows = payments
    .map((item) => {
      const amount = `€${(item.amount_eur_cents / 100).toFixed(2)}`;
      const statusClass = item.status === "paid" ? "paid" : "pending";
      const statusLabel = item.status === "paid" ? "Pagado" : "Pendiente";

      return `
        <tr>
          <td>${item.id}</td>
          <td>${item.rank_name}</td>
          <td>${amount}</td>
          <td><span class="badge-status ${statusClass}">${statusLabel}</span></td>
          <td>${new Date(item.created_at).toLocaleString("es-ES")}</td>
        </tr>
      `;
    })
    .join("");

  paymentsBox.innerHTML = `
    <table class="payments-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Rango</th>
          <th>Monto</th>
          <th>Estado</th>
          <th>Fecha</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function loadPayments() {
  if (!currentSession.loggedIn) {
    paymentsBox.innerHTML = "<p style=\"padding:0.8rem;\">Inicia sesión para ver tus pagos.</p>";
    return;
  }

  const data = await fetchJson("/api/payments/me");
  renderPayments(data.payments);
}

async function loadSession() {
  try {
    currentSession = await fetchJson("/api/session");
  } catch {
    currentSession = { loggedIn: false, user: null };
  }

  if (currentSession.loggedIn) {
    sessionText.textContent = `Sesión activa como ${currentSession.user.minecraft_name}.`;
  } else {
    sessionText.textContent = "No has iniciado sesión con Minecraft.";
  }

  renderNav();
  renderCards();
  await loadPayments();
}

loadSession();
