const ranks = [
  {
    name: "Ciudadano",
    price: "€4.99 / mes",
    perks: ["🏡 1 /home extra", "🔫 1 fusil", "🛡️ 1 kit de armadura"],
  },
  {
    name: "Diplomático",
    price: "€9.99 / mes",
    perks: ["🏡 2 /home extra", "🔫 3 fusiles", "🛡️ 2 kit de armadura"],
  },
  {
    name: "Senador",
    price: "€19.99 / mes",
    perks: ["🏡 3 /home extra", "🔫 5 fusiles", "🛡️ 5 kit de armadura"],
  },
  {
    name: "Canciller",
    price: "€34.99 / mes",
    perks: ["🪽 /t fly", "🏡 3 /home extra", "🔫 10 fusiles", "🛡️ 10 kits de armadura"],
  },
];

const cardsContainer = document.getElementById("cards-container");
const sessionText = document.getElementById("session-text");
const paymentsBox = document.getElementById("payments-box");
const navActions = document.getElementById("nav-actions");
const statusMessage = document.getElementById("status-message");
const loginForm = document.getElementById("login-form");
const registerForm = document.getElementById("register-form");
const manualBox = document.getElementById("manual-box");
const adminPanel = document.getElementById("admin-panel");
const adminPaymentsBox = document.getElementById("admin-payments-box");

let currentSession = { loggedIn: false, user: null };
let paymentInstructions = null;

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
    navActions.innerHTML = "";
    return;
  }

  navActions.innerHTML = `
    <span>${currentSession.user.minecraft_name}${currentSession.user.isAdmin ? " (ADMIN)" : ""}</span>
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
      <ul>${rank.perks.map((perk) => `<li>${perk}</li>`).join("")}</ul>
      <button class="btn buy-btn" data-rank="${rank.name}" ${currentSession.loggedIn ? "" : "disabled"}>
        ${
          currentSession.loggedIn
            ? currentSession.user?.isAdmin
              ? `Activar ${rank.name} gratis`
              : `Comprar ${rank.name}`
            : "Inicia sesión para comprar"
        }
      </button>
    `;

    cardsContainer.appendChild(card);
  });

  document.querySelectorAll(".buy-btn[data-rank]").forEach((button) => {
    button.addEventListener("click", async () => {
      const rankName = button.getAttribute("data-rank");
      setStatus(currentSession.user?.isAdmin ? "Activando rango..." : "Registrando compra...");

      try {
        const url = currentSession.user?.isAdmin ? "/api/admin/grant-rank" : "/api/payments";
        const data = await fetchJson(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rankName }),
        });

        setStatus(data.message);
        if (data.paymentUrl) {
          window.open(data.paymentUrl, "_blank", "noopener,noreferrer");
        } else if (!currentSession.user?.isAdmin && data.paymentId) {
          setStatus(
            `${data.message} Usa como concepto: Pedido #${data.paymentId} - ${currentSession.user.minecraft_name}`
          );
        }
        await loadPayments();
        if (currentSession.user?.isAdmin) {
          await loadAdminPayments();
        }
      } catch (error) {
        setStatus(error.message);
      }
    });
  });
}

function renderPayments(payments) {
  if (!payments.length) {
    paymentsBox.innerHTML = '<p style="padding:0.8rem;">Todavía no hay pagos registrados.</p>';
    return;
  }

  const rows = payments
    .map((item) => {
      const amount = `€${(item.amount_eur_cents / 100).toFixed(2)}`;
      const statusClass = item.status === "paid" ? "paid" : "pending";
      const statusLabel = item.status === "paid" ? "Pagado" : "Pendiente";

      return `<tr>
          <td>${item.id}</td>
          <td>${item.rank_name}</td>
          <td>${amount}</td>
          <td><span class="badge-status ${statusClass}">${statusLabel}</span></td>
          <td>${new Date(item.created_at).toLocaleString("es-ES")}</td>
        </tr>`;
    })
    .join("");

  paymentsBox.innerHTML = `<table class="payments-table"><thead><tr><th>ID</th><th>Rango</th><th>Monto</th><th>Estado</th><th>Fecha</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function loadPayments() {
  if (!currentSession.loggedIn) {
    paymentsBox.innerHTML = '<p style="padding:0.8rem;">Inicia sesión para ver tus pagos.</p>';
    return;
  }

  const data = await fetchJson("/api/payments/me");
  renderPayments(data.payments);
}

function renderManualInstructions() {
  if (!paymentInstructions) {
    manualBox.innerHTML = "<p>No se pudieron cargar instrucciones de pago.</p>";
    return;
  }

  if (paymentInstructions.hasExternalCheckout) {
    manualBox.innerHTML =
      "<p>Hay pasarela externa activa. Al pulsar comprar se abrirá el pago automáticamente.</p>";
    return;
  }

  const destination = paymentInstructions.destination
    ? `<strong>${paymentInstructions.destination}</strong>`
    : "<strong>(configurar destino en Vercel)</strong>";

  const note = paymentInstructions.note
    ? `<p><strong>Nota:</strong> ${paymentInstructions.note}</p>`
    : "";

  manualBox.innerHTML = `
    <p><strong>Método:</strong> ${paymentInstructions.method}</p>
    <p><strong>Destino:</strong> ${destination}</p>
    <p><strong>Concepto obligatorio:</strong> Pedido #ID - TuUsuarioMinecraft</p>
    <p>Cuando pagues, el admin lo revisa y marca tu pedido como pagado.</p>
    ${note}
  `;
}

function renderAdminPayments(payments) {
  if (!payments.length) {
    adminPaymentsBox.innerHTML = '<p style="padding:0.8rem;">No hay pedidos.</p>';
    return;
  }

  const rows = payments
    .map((item) => {
      const amount = `€${(item.amount_eur_cents / 100).toFixed(2)}`;
      const statusLabel = item.status === "paid" ? "Pagado" : "Pendiente";
      const action =
        item.status === "pending"
          ? `<button class="admin-action-btn" data-admin-mark="${item.id}">Marcar pagado</button>`
          : "-";
      return `<tr>
        <td>${item.id}</td>
        <td>${item.minecraft_name || "-"}</td>
        <td>${item.rank_name}</td>
        <td>${amount}</td>
        <td>${statusLabel}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join("");

  adminPaymentsBox.innerHTML = `<table class="payments-table"><thead><tr><th>ID</th><th>Usuario</th><th>Rango</th><th>Monto</th><th>Estado</th><th>Acción</th></tr></thead><tbody>${rows}</tbody></table>`;

  document.querySelectorAll("[data-admin-mark]").forEach((button) => {
    button.addEventListener("click", async () => {
      const paymentId = button.getAttribute("data-admin-mark");
      try {
        const data = await fetchJson(`/api/admin/payments/${paymentId}/mark-paid-session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerRef: "manual-admin-ui" }),
        });
        setStatus(data.message || "Pago marcado.");
        await loadAdminPayments();
        await loadPayments();
      } catch (error) {
        setStatus(error.message);
      }
    });
  });
}

async function loadAdminPayments() {
  if (!currentSession.loggedIn || !currentSession.user?.isAdmin) {
    adminPanel.style.display = "none";
    adminPaymentsBox.innerHTML = '<p style="padding:0.8rem;">Inicia sesión como admin para gestionar pagos.</p>';
    return;
  }

  adminPanel.style.display = "block";
  const data = await fetchJson("/api/admin/payments-session");
  renderAdminPayments(data.payments || []);
}

async function loadPaymentInstructions() {
  paymentInstructions = await fetchJson("/api/payment-instructions");
  renderManualInstructions();
}

async function loadSession() {
  try {
    currentSession = await fetchJson("/api/session");
  } catch {
    currentSession = { loggedIn: false, user: null };
  }

  if (currentSession.loggedIn) {
    sessionText.textContent = currentSession.user.isAdmin
      ? `Sesión activa como ${currentSession.user.minecraft_name} (admin). Puedes activar rangos gratis.`
      : `Sesión activa como ${currentSession.user.minecraft_name}.`;
  } else {
    sessionText.textContent = "No has iniciado sesión.";
  }

  renderNav();
  renderCards();
  await loadPaymentInstructions();
  await loadPayments();
  await loadAdminPayments();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);

  try {
    const data = await fetchJson("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });
    setStatus(data.message);
    loginForm.reset();
    await loadSession();
  } catch (error) {
    setStatus(error.message);
  }
});

registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(registerForm);

  try {
    const data = await fetchJson("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });
    setStatus(data.message);
    registerForm.reset();
    await loadSession();
  } catch (error) {
    setStatus(error.message);
  }
});

const heroLogo = document.querySelector(".hero-logo");
const heroLogoFallback = document.getElementById("hero-logo-fallback");

if (heroLogo && heroLogoFallback) {
  heroLogo.addEventListener("error", () => {
    heroLogo.style.display = "none";
    heroLogoFallback.style.display = "block";
  });
}

loadSession();
