import { API_URL } from "./config.js";


// Check Admin login

async function checkAdmin() {

    const response = await fetch(
        API_URL + "/api/admin/check",
        {
            credentials: "include"
        }
    );

    if (!response.ok) {

        window.location.href =
            "login.html";

        return false;
    }

    return true;
}


// Load current Admin username

async function loadAdminAccount() {

    const loggedIn =
        await checkAdmin();

    if (!loggedIn) {
        return;
    }


    const response = await fetch(
        API_URL + "/api/admin/account",
        {
            credentials: "include"
        }
    );

    if (!response.ok) {

        window.location.href =
            "login.html";

        return;
    }


    const account =
        await response.json();


    document.getElementById(
        "currentUsername"
    ).value = account.username;

}

loadAdminAccount();


// Show / Hide passwords

const passwordEyeButtons =
    document.querySelectorAll(
        ".password-eye"
    );


passwordEyeButtons.forEach(
    function(button) {

        button.addEventListener(
            "click",
            function() {

                const targetId =
                    button.dataset.target;

                const passwordInput =
                    document.getElementById(
                        targetId
                    );

                const eyeShow =
                    button.querySelector(
                        ".eye-show"
                    );

                const eyeHide =
                    button.querySelector(
                        ".eye-hide"
                    );


                const passwordVisible =
                    passwordInput.type === "text";


                if (passwordVisible) {

                    passwordInput.type =
                        "password";

                    eyeShow.hidden = false;
                    eyeHide.hidden = true;

                    button.setAttribute(
                        "aria-label",
                        "Show password"
                    );

                } else {

                    passwordInput.type =
                        "text";

                    eyeShow.hidden = true;
                    eyeHide.hidden = false;

                    button.setAttribute(
                        "aria-label",
                        "Hide password"
                    );

                }

            }
        );

    }
);


// Update Admin account

const updateAccountButton =
    document.getElementById(
        "updateAccountButton"
    );


updateAccountButton.addEventListener(
    "click",
    async function() {

        const currentPassword =
            document.getElementById(
                "currentPassword"
            ).value;

        const newUsername =
            document.getElementById(
                "newUsername"
            ).value;

        const newPassword =
            document.getElementById(
                "newPassword"
            ).value;

        const confirmNewPassword =
            document.getElementById(
                "confirmNewPassword"
            ).value;

        const accountMessage =
            document.getElementById(
                "accountMessage"
            );


        accountMessage.textContent = "";


        const response = await fetch(
            API_URL + "/api/admin/account",
            {
                method: "PUT",

                credentials: "include",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    currentPassword,
                    newUsername,
                    newPassword,
                    confirmNewPassword
                })
            }
        );


        const result =
            await response.json();


        if (!response.ok) {

            accountMessage.textContent =
                result.message ||
                "Account update failed";

            return;
        }


        alert(result.message);

        window.location.href =
            "login.html";

    }
);


// Back to Admin Panel

const backToAdminButton =
    document.getElementById(
        "backToAdminButton"
    );


backToAdminButton.addEventListener(
    "click",
    function() {

        window.location.href =
            "admin.html";

    }
);