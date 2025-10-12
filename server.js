const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
require('dotenv').config(); // Для чтения .env файла

const app = express();
const server = http.createServer(app);
// Настраиваем Socket.io
const io = new Server(server);

// --- 🎯 ГЛОБАЛЬНОЕ СОСТОЯНИЕ ДЕБАТОВ ---
let debateState = {
    // Настройки
    theme: "Тема дебатов еще не задана",
    timers: {
        blue: 60, // Время речи Синих по умолчанию (сек)
        red: 60,  // Время речи Красных по умолчанию (сек)
        vote: 30, // Время голосования по умолчанию (сек)
    },
    // Текущее состояние
    currentPhase: "Неактивно", // 'Речь синих', 'Речь красных', 'Голосование', 'Пауза'
    remainingTime: 0,
    // Голосование (храним ID клиента и его выбор, чтобы нельзя было голосовать дважды)
    votes: {
        blue: 0,
        red: 0,
        voters: {}, // { socketId: 'blue' | 'red' }
    }
};

let timerInterval = null;
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'default_password'; // Пароль из .env

// --- 📡 ФУНКЦИИ СИНХРОНИЗАЦИИ ---

/**
 * Рассчитывает и отправляет текущее состояние дебатов всем клиентам.
 */
function broadcastState() {
    const totalVotes = debateState.votes.blue + debateState.votes.red;
    // Округляем до целых, используем 50% / 50% если голосов нет
    const bluePercent = totalVotes > 0 ? ((debateState.votes.blue / totalVotes) * 100).toFixed(0) : 50; 
    const redPercent = totalVotes > 0 ? ((debateState.votes.red / totalVotes) * 100).toFixed(0) : 50;

    io.emit('debateState', {
        ...debateState,
        percentages: {
            blue: parseInt(bluePercent),
            red: parseInt(redPercent),
            total: totalVotes
        }
    });
}

/**
 * Основная функция таймера, вызывается каждую секунду.
 */
function startTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
    }
    
    // Запускаем новый интервал
    timerInterval = setInterval(() => {
        if (debateState.remainingTime > 0) {
            debateState.remainingTime -= 1;
            broadcastState(); // Обновляем время у всех
        } else {
            // Время истекло, останавливаем таймер
            clearInterval(timerInterval);
            timerInterval = null;
            
            // Установка фазы в "Пауза" после завершения таймера
            if (debateState.currentPhase !== "Неактивно") {
                console.log(`Фаза "${debateState.currentPhase}" завершена.`);
                debateState.currentPhase = "Пауза"; 
                broadcastState();
            }
        }
    }, 1000); // 1000 миллисекунд = 1 секунда
}

/**
 * Сбрасывает все таймеры и голоса.
 */
function resetAll() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    debateState.currentPhase = "Неактивно";
    debateState.remainingTime = 0;
    debateState.votes = { blue: 0, red: 0, voters: {} };
    broadcastState();
    console.log("Состояние дебатов сброшено.");
}

// --- 🌐 ОБРАБОТКА СОЕДИНЕНИЙ SOCKET.IO ---

io.on('connection', (socket) => {
    console.log('Новый пользователь подключился:', socket.id);

    // 1. При подключении сразу отправляем клиенту текущее состояние
    broadcastState();

    // 2. Обработка команд Ведущего (с проверкой пароля)
    socket.on('hostCommand', (data) => {
        const { command, password, payload } = data;

        // Если команда не 'auth' (вход), проверяем, авторизован ли ведущий.
        // Для простоты, пока проверяем пароль при каждой команде.
        if (password !== HOST_PASSWORD) {
            socket.emit('authError', '❌ Неверный пароль'); 
            return;
        }

        console.log(`Команда от ведущего (${socket.id}): ${command}`, payload);
        
        switch (command) {
            case 'setTheme':
                debateState.theme = payload.newTheme;
                broadcastState();
                break;
            case 'setTimer':
                // payload: { type: 'blue'|'red'|'vote', duration: 60 }
                const duration = parseInt(payload.duration);
                if (duration > 0) {
                    debateState.timers[payload.type] = duration;
                    broadcastState();
                }
                break;
            case 'startPhase':
                // payload: { phase: 'Речь синих'|'Речь красных'|'Голосование' }
                let phaseDuration;
                if (payload.phase === 'Речь синих') phaseDuration = debateState.timers.blue;
                else if (payload.phase === 'Речь красных') phaseDuration = debateState.timers.red;
                else if (payload.phase === 'Голосование') {
                    phaseDuration = debateState.timers.vote;
                    // Сброс голосов для новой фазы голосования
                    debateState.votes = { blue: 0, red: 0, voters: {} };
                } else return; // Неизвестная фаза

                debateState.currentPhase = payload.phase;
                debateState.remainingTime = phaseDuration;
                startTimer();
                broadcastState();
                break;
            case 'stopPhase':
                if (timerInterval) {
                    clearInterval(timerInterval);
                    timerInterval = null;
                }
                debateState.currentPhase = "Пауза";
                broadcastState();
                break;
            case 'resetAll':
                resetAll();
                break;
        }
    });

    // 3. Обработка голосов от Зрителей
    socket.on('submitVote', (data) => {
        const { side } = data; // side: 'blue' или 'red'
        
        // ❌ Проверка 1: Можно голосовать только в фазе "Голосование"
        if (debateState.currentPhase !== 'Голосование') {
            socket.emit('voteError', 'Голосование сейчас неактивно.');
            return;
        }

        // ❌ Проверка 2: Голосовать можно только один раз за раунд
        if (debateState.votes.voters[socket.id]) {
            socket.emit('voteError', 'Вы уже проголосовали в этом раунде.');
            return;
        }

        // ✅ Принимаем голос
        if (side === 'blue') {
            debateState.votes.blue += 1;
        } else if (side === 'red') {
            debateState.votes.red += 1;
        } else {
            return; // Некорректная сторона
        }
        
        // Регистрируем, что этот пользователь проголосовал
        debateState.votes.voters[socket.id] = side; 
        
        console.log(`Новый голос для ${side}. Всего: ${debateState.votes.blue} 🔵 / ${debateState.votes.red} 🔴`);

        // Отправляем подтверждение и обновленное состояние всем
        socket.emit('voteConfirmed', 'Спасибо за ваш голос!');
        broadcastState();
    });

    // 4. Обработка отключения
    socket.on('disconnect', () => {
        console.log('Пользователь отключился:', socket.id);
    });
});

// --- 🚀 ЗАПУСК СЕРВЕРА ---

// Раздача статических файлов из папки 'public' (здесь будет наш HTML/CSS/JS)
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Сервер запущен на http://localhost:${PORT}`);
    console.log(`Пароль ведущего: ${HOST_PASSWORD}`);
});
