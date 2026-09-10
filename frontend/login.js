import { API_URL } from "./config.js";

const loginForm =
    document.getElementById("loginForm");

const loginMessage =
    document.getElementById("loginMessage");

const passwordInput = document.getElementById("password");
const togglePassword = document.getElementById("togglePassword");

togglePassword.addEventListener("click", function() {
    const showPassword = passwordInput.type === "password";
    passwordInput.type = showPassword ? "text" : "password";
    togglePassword.textContent = showPassword ? "Hide" : "Show";
    togglePassword.setAttribute("aria-label", showPassword ? "Hide password" : "Show password");
});


loginForm.addEventListener(
    "submit",
    async function(event) {

        event.preventDefault();

        const username =
            document.getElementById("username").value;

        const password =
            document.getElementById("password").value;


        const response = await fetch(
            API_URL + "/api/login",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                credentials: "include",

                body: JSON.stringify({
                    username: username,
                    password: password
                })
            }
        );


        const result =
            await response.json();


        if (!response.ok) {

            loginMessage.textContent =
                result.message;

            return;

        }


        window.location.href =
            "admin.html";

    }
);
