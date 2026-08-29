
async function testPut() {

    const response = await fetch(
        "http://localhost:3000/api/movies/12",
        {
            method: "PUT",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                poster: "Humint (2026).webp",
                title: "Humint",
                category: "Action - Drama - Thriller",
                year: 2026,
                link: "https://t.me/luckymovie/14",
                review: "Spy game ထဲမှာ အကြီးဆုံး enemy က trust ပဲ..\nနယ်စပ်က တောင်မြောက် အေးဂျင့်တွေကြားက ပြင်းထန်တဲ့ အားပြိုင်မှု..သူ့ဘက် ကိုယ့်ဘက် မဟုတ်ဘူးအသက်ရှင်ဖို့ဘက်ပဲ..\nဒီတစ်ခေါက်မှာတော့ အက်ရှင်နဲ့ အေးဂျင့်ကားတွေ ကြိုက်နှစ်သက်တဲ့ ဝါသနာရှင်တွေအတွက် မဖြစ်မနေ စောင့်ကြည့်ရမဲ့ “Humint” ဆိုတဲ့ ရုပ်ရှင်ကားသစ်လေးနဲ့ မိတ်ဆက်ပေးချင်ပါတယ်။ နယ်စပ်ဒေသက လျှို့ဝှက်ချက်တွေနဲ့အတူ အသက်ရှူမှားလောက်မဲ့ အားပြိုင်မှုတွေကို ဘယ်လို Cinematic Style မျိုးနဲ့ မြင်တွေ့ရမလဲဆိုတာ ရင်ခုန်စရာပါ။\nနယ်စပ်က သွေးအေးစစ်ပွဲကြားမှာ ဘယ်သူက ရန်သူ၊ ဘယ်သူက မိတ်ဆွေလဲ။ ပန်းတိုင်တစ်ခုတည်းအတွက် ထိပ်တိုက်တွေ့ကြမဲ့ အေးဂျင့်တွေရဲ့ ကစားပွဲမှာ နောက်ဆုံး ဘယ်သူက အနိုင်ရရှိမလဲ။\nဒီဇာတ်ကားကို “Veteran” နဲ့ “Escape from Mogadishu” တို့လို နာမည်ကြီး အက်ရှင်ကားတွေကို ဖန်တီးခဲ့တဲ့ ဒါရိုက်တာ Ryu Seung Wan က ရိုက်ကူးထားတာဖြစ်လို့ သူ့ရဲ့ ထူးခြားတဲ့ Narrative Vibe နဲ့ အမိုက်စား အက်ရှင်ကွက်တွေကို စိတ်ချလက်ချ စောင့်မျှော်ကြည့်ရှုနိုင်မှာပါ။",
                fileSize: "1.69GB",
                quality: "1080P",
                duration: "2hr 2min",
                rating: "6.6/10",
                type: "movie",
                episodes: null
            })
        }
    );

    const result = await response.json();

    console.log(result);
}

testPut();

