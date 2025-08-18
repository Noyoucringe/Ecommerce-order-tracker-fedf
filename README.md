| Student ID | Student Name  | Section |
| ---------- | ------------- | ------- |
| 2410030128 | P. Anirudh    | A5      |
| 2410030030 | TGSS. Rohit   | A5      |
| 2410030122 | T. Rishika    | A5      |
| 2410030123 | Surabhi Sarda | A5      |
| 2410030254 | B. Santosh    | A5      |
| 2410030442 | Maruthi Reddy | A5      |

📝 Project Description

This project is an E-commerce Order Live Tracking System that allows customers to track their order status in real time. Unlike existing solutions (e.g., Zepto, BlinkIt, Swiggy), our system focuses on a frontend-only simulation that demonstrates order progress, ETA (Estimated Time of Arrival), and visual tracking without requiring a heavy backend.
We enhance the tracking experience by adding progress visualization, ETA updates, and a map-based order journey to make it more interactive and user-friendly.

📂 Project Contents

Frontend (HTML, CSS, JS) – UI for entering order ID and viewing live status.
Backend (Node.js + Express) – API for fetching order details (status, ETA, progress).
Database (Dummy/SQL) – Order details like order ID, status, location, ETA.
Live Tracking Map (Optional) – Google Maps API to visualize delivery movement.

🎯 Expected Outcome

Customers can enter an Order ID and view the live order status.
Order progress is shown with percentage completion & ETA.
Provides a visual tracking experience similar to real-world delivery apps.
Helps in learning and demonstrating frontend-backend integration in an e-commerce scenario.

# Order Tracker (Demo)

Quick start on Windows (PowerShell):
1. Duplicate `.env.example` as `.env` and set:
   - OPENAI_API_KEY=sk-...
   - Optionally AFTERSHIP_API_KEY for live carrier tracking
2. Start the server (from this folder):
   - node server.js
3. Open http://localhost:3000 and hard refresh (Ctrl+F5)


